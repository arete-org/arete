/**
 * @description: Trusted-service auth and Turnstile verification helpers for the reflect endpoint.
 * @footnote-scope: utility
 * @footnote-module: ReflectAuth
 * @footnote-risk: high - Auth or CAPTCHA mistakes can open the endpoint to abuse or block trusted callers.
 * @footnote-ethics: high - Abuse controls and trusted-service access affect fairness and reliability.
 */
import type { IncomingMessage } from 'node:http';
import { runtimeConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ReflectFailureResponse } from './reflectResponses.js';

/**
 * Result of checking whether a caller is one of our trusted internal services.
 */
export type ServiceAuth = {
    isTrustedService: boolean;
    authSource: 'x-trace-token' | 'x-service-token' | null;
    rateLimitKey: string | null;
};

/**
 * Auth context the handler needs after headers are inspected but before rate limiting.
 */
export type ReflectAuthContext = {
    serviceAuth: ServiceAuth;
    turnstileToken: string | null;
    tokenSource: 'header' | 'none';
    skipCaptcha: boolean;
    skipReason: string | null;
};

// Normalize Node's string-or-string[] header shape into one trimmed value.
const readHeaderValue = (
    headerValue: string | string[] | undefined
): string | null => {
    if (!headerValue) {
        return null;
    }

    const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const trimmedValue = rawValue.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
};

/**
 * Trusted server-side callers can authenticate with the shared trace token or
 * a reflect-specific service token. Public browser traffic never uses this path.
 */
export const getServiceAuth = (req: IncomingMessage): ServiceAuth => {
    const traceHeaderValue = readHeaderValue(req.headers['x-trace-token']);
    if (
        runtimeConfig.trace.apiToken &&
        traceHeaderValue === runtimeConfig.trace.apiToken
    ) {
        return {
            isTrustedService: true,
            authSource: 'x-trace-token',
            rateLimitKey: 'trace-token',
        };
    }

    const serviceHeaderValue = readHeaderValue(req.headers['x-service-token']);
    if (
        runtimeConfig.reflect.serviceToken &&
        serviceHeaderValue === runtimeConfig.reflect.serviceToken
    ) {
        return {
            isTrustedService: true,
            authSource: 'x-service-token',
            rateLimitKey: 'service-token',
        };
    }

    return {
        isTrustedService: false,
        authSource: null,
        rateLimitKey: null,
    };
};

/**
 * Chooses the auth path for this request:
 * - trusted service token
 * - public caller with required Turnstile
 * - public caller with CAPTCHA skipped because Turnstile is disabled
 */
export const resolveReflectAuth = (
    req: IncomingMessage
): 
    | { success: true; data: ReflectAuthContext }
    | { success: false; error: ReflectFailureResponse } => {
    const serviceAuth = getServiceAuth(req);
    const hasTurnstileSecret = Boolean(runtimeConfig.turnstile.secretKey);
    const hasTurnstileSite = Boolean(runtimeConfig.turnstile.siteKey);
    // Public traffic needs both Turnstile keys. Trusted services can still use the endpoint
    // because they authenticate through headers instead of browser CAPTCHA.
    if (
        hasTurnstileSecret !== hasTurnstileSite &&
        !serviceAuth.isTrustedService
    ) {
        return {
            success: false,
            error: {
                statusCode: 503,
                payload: {
                    error: 'CAPTCHA verification not configured',
                    details:
                        'TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY must both be set',
                },
                logLabel: 'reflect captcha-misconfigured',
            },
        };
    }

    let turnstileToken: string | null = null;
    let tokenSource: 'header' | 'none' = 'none';
    if (req.headers['x-turnstile-token']) {
        const headerToken = req.headers['x-turnstile-token'];
        if (Array.isArray(headerToken)) {
            turnstileToken = headerToken[0];
        } else {
            turnstileToken = String(headerToken);
        }
        tokenSource = 'header';
    }

    // We skip CAPTCHA either for trusted services or when Turnstile is fully disabled.
    const skipCaptcha =
        serviceAuth.isTrustedService ||
        !(hasTurnstileSecret && hasTurnstileSite);
    if (!turnstileToken && !skipCaptcha) {
        return {
            success: false,
            error: {
                statusCode: 403,
                payload: {
                    error: 'CAPTCHA verification failed',
                    details: 'Missing turnstile token',
                },
                logLabel: 'reflect missing-captcha-token',
            },
        };
    }

    // This label is used only for logs so we can explain why CAPTCHA was skipped later.
    const skipReason = skipCaptcha
        ? serviceAuth.isTrustedService
            ? `trusted-service-${serviceAuth.authSource}`
            : !runtimeConfig.turnstile.secretKey
              ? 'not-configured'
              : 'dev-mode'
        : null;

    return {
        success: true,
        data: {
            serviceAuth,
            turnstileToken,
            tokenSource,
            skipCaptcha,
            skipReason,
        },
    };
};

/**
 * Inputs needed to verify a public Turnstile token.
 * We pass request host/origin separately so failure logs preserve request context.
 */
type VerifyTurnstileInput = {
    clientIp: string;
    requestHost: string | undefined;
    requestOrigin: string | undefined;
    turnstileToken: string | null;
    tokenSource: 'header' | 'none';
};

const normalizeHostname = (value: string | undefined): string | null => {
    if (!value) {
        return null;
    }

    const trimmedValue = value.trim().toLowerCase();
    if (trimmedValue.length === 0) {
        return null;
    }

    const withoutProtocol = trimmedValue.replace(/^[a-z]+:\/\//, '');
    const hostname = withoutProtocol.split('/')[0]?.split(':')[0]?.trim();
    return hostname && hostname.length > 0 ? hostname : null;
};

type TurnstileHostnameValidation = {
    validationMode: 'configured-allowlist' | 'request-derived';
    configuredHostnames: string[];
    derivedHostnames: string[];
    effectiveHostnames: string[];
};

const resolveTurnstileHostnameValidation = (
    requestHost: string | undefined,
    requestOrigin: string | undefined
): TurnstileHostnameValidation => {
    const configuredHostnames = runtimeConfig.turnstile.allowedHostnames;
    const derivedHostnames = [
        normalizeHostname(requestHost),
        normalizeHostname(requestOrigin),
    ].filter((hostname): hostname is string => Boolean(hostname));

    if (configuredHostnames.length > 0) {
        return {
            validationMode: 'configured-allowlist',
            configuredHostnames,
            derivedHostnames,
            effectiveHostnames: configuredHostnames,
        };
    }

    return {
        validationMode: 'request-derived',
        configuredHostnames,
        derivedHostnames,
        effectiveHostnames: [...new Set(derivedHostnames)],
    };
};

/**
 * Verifies a public Turnstile token and converts provider/network failures into
 * the structured reflect error shape used by the handler.
 */
export const verifyTurnstileCaptcha = async ({
    clientIp,
    requestHost,
    requestOrigin,
    turnstileToken,
    tokenSource,
}: VerifyTurnstileInput): Promise<
    | { success: true }
    | { success: false; error: ReflectFailureResponse }
> => {
    try {
        // These logs help separate caller mistakes from upstream Turnstile failures.
        logger.debug('CAPTCHA verification debug:');
        logger.debug(`  Token source: ${tokenSource}`);
        logger.debug(`  Token length: ${turnstileToken?.length || 0}`);
        logger.debug(
            `  Secret key is set: ${!!runtimeConfig.turnstile.secretKey}`
        );

        if (!turnstileToken || turnstileToken.trim().length === 0) {
            logger.error('CAPTCHA verification attempted without a token');
            return {
                success: false,
                error: {
                    statusCode: 400,
                    payload: {
                        error: 'CAPTCHA token is required',
                        details: 'Missing turnstile token',
                    },
                    logLabel: 'reflect missing-captcha-token',
                },
            };
        }

        if (!runtimeConfig.turnstile.secretKey) {
            logger.error('CAPTCHA verification attempted without secret key');
            return {
                success: false,
                error: {
                    statusCode: 503,
                    payload: {
                        error: 'CAPTCHA verification not configured',
                        details: 'TURNSTILE_SECRET_KEY is not set',
                    },
                    logLabel: 'reflect captcha-not-configured',
                },
            };
        }

        const formData = new URLSearchParams();
        formData.append('secret', runtimeConfig.turnstile.secretKey);
        formData.append('response', turnstileToken);
        formData.append('remoteip', clientIp);

        // Timeout Turnstile calls so a slow upstream provider does not hang the endpoint.
        let abortSignal: AbortSignal;
        try {
            abortSignal = AbortSignal.timeout(10000);
        } catch {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 10000);
            abortSignal = controller.signal;
        }

        const verificationResponse = await fetch(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: formData.toString(),
                signal: abortSignal,
            }
        );

        // Distinguish "Turnstile rejected the token" from "Turnstile itself failed."
        if (!verificationResponse.ok) {
            const errorText = await verificationResponse
                .text()
                .catch(() => 'Unable to read error response');
            logger.error(
                `Turnstile verification service error: ${verificationResponse.status} ${verificationResponse.statusText}`
            );
            logger.error(`Error response body: ${errorText}`);

            let errorDetails: { 'error-codes'?: string[] };
            try {
                errorDetails = JSON.parse(errorText) as {
                    'error-codes'?: string[];
                };
            } catch {
                errorDetails = { 'error-codes': ['unknown-error'] };
            }

            const errorCodes = errorDetails['error-codes'] || [];
            if (
                errorCodes.includes('invalid-input-secret') ||
                errorCodes.includes('missing-input-secret')
            ) {
                logger.error(
                    'CAPTCHA configuration error: Secret key is invalid or does not match site key'
                );
                return {
                    success: false,
                    error: {
                        statusCode: 403,
                        payload: {
                            error: 'CAPTCHA verification failed',
                            details:
                                'Invalid CAPTCHA configuration. Secret key does not match site key.',
                        },
                        logLabel: `reflect captcha-config-error codes=${errorCodes.join(',')}`,
                    },
                };
            }

            // Surface upstream outages as 502s rather than pretending the caller failed verification.
            throw new Error(
                `Verification service returned ${verificationResponse.status}: ${errorText}`
            );
        }

        const verificationData = (await verificationResponse.json()) as {
            success?: boolean;
            hostname?: string;
            'error-codes'?: string[];
            'challenge-ts'?: string;
        };
        const normalizedResponseHostname = normalizeHostname(
            verificationData.hostname
        );
        const normalizedRequestHost = normalizeHostname(requestHost);
        const normalizedRequestOrigin = normalizeHostname(requestOrigin);
        const hostnameValidation = resolveTurnstileHostnameValidation(
            requestHost,
            requestOrigin
        );

        logger.debug(
            `Turnstile verification response: ${JSON.stringify(verificationData, null, 2)}`
        );
        logger.debug(
            `Turnstile hostname validation: ${JSON.stringify({
                validationMode: hostnameValidation.validationMode,
                configuredHostnames: hostnameValidation.configuredHostnames,
                derivedHostnames: hostnameValidation.derivedHostnames,
                effectiveHostnames: hostnameValidation.effectiveHostnames,
                verifiedHostname: normalizedResponseHostname,
            })}`
        );

        // A non-success response means the caller failed verification, even though the upstream call worked.
        if (!verificationData.success) {
            const errorCodes = verificationData['error-codes'] || [];
            const errorCodesStr =
                errorCodes.join(', ') || 'Unknown verification error';

            logger.error('CAPTCHA verification FAILED:');
            logger.error(`  Error codes: ${errorCodesStr}`);
            logger.error(`  Token source: ${tokenSource}`);
            logger.error(`  Token length: ${turnstileToken?.length || 0}`);
            logger.error(
                `  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`
            );
            logger.error(`  Hostname from response: ${normalizedResponseHostname || 'N/A'}`);
            logger.error(`  Request hostname: ${normalizedRequestHost || 'N/A'}`);
            logger.error(`  Request origin: ${normalizedRequestOrigin || 'N/A'}`);

            return {
                success: false,
                error: {
                    statusCode: 403,
                    payload: {
                        error: 'CAPTCHA verification failed',
                        details: errorCodesStr,
                    },
                    logLabel: `reflect captcha-failed source=${tokenSource} errors=${errorCodesStr}`,
                },
            };
        }

        const hostnameMatches = Boolean(
            normalizedResponseHostname &&
                hostnameValidation.effectiveHostnames.includes(
                    normalizedResponseHostname
                )
        );
        if (!hostnameMatches) {
            logger.error('CAPTCHA verification FAILED:');
            logger.error('  Error codes: hostname mismatch');
            logger.error(`  Token source: ${tokenSource}`);
            logger.error(`  Token length: ${turnstileToken?.length || 0}`);
            logger.error(
                `  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`
            );
            logger.error(`  Hostname from response: ${normalizedResponseHostname || 'N/A'}`);
            logger.error(`  Request hostname: ${normalizedRequestHost || 'N/A'}`);
            logger.error(`  Request origin: ${normalizedRequestOrigin || 'N/A'}`);
            logger.error(
                `  Validation mode: ${hostnameValidation.validationMode}`
            );
            logger.error(
                `  Configured hostnames: ${hostnameValidation.configuredHostnames.join(', ') || 'N/A'}`
            );
            logger.error(
                `  Derived hostnames: ${hostnameValidation.derivedHostnames.join(', ') || 'N/A'}`
            );
            logger.error(
                `  Effective hostnames: ${hostnameValidation.effectiveHostnames.join(', ') || 'N/A'}`
            );

            return {
                success: false,
                error: {
                    statusCode: 403,
                    payload: {
                        error: 'CAPTCHA verification failed',
                        details: 'hostname mismatch',
                    },
                    logLabel: `reflect captcha-hostname-mismatch source=${tokenSource}`,
                },
            };
        }

        logger.info(
            `CAPTCHA verification SUCCESS for token from ${tokenSource}`
        );
        logger.info(`  Hostname verified: ${normalizedResponseHostname || 'N/A'}`);
        logger.info(`  Expected hostname: ${normalizedRequestHost || 'N/A'}`);
        logger.info(
            `  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`
        );
        return { success: true };
    } catch (error) {
        // Network/timeouts reach this block. Those are provider-side failures, not bad user input.
        logger.error('=== CAPTCHA Verification Error ===');
        logger.error(
            `Error type: ${(error as Error)?.constructor?.name ?? 'unknown'}`
        );
        logger.error(
            `Error message: ${error instanceof Error ? error.message : String(error)}`
        );
        logger.error(
            `Error stack: ${error instanceof Error ? error.stack : 'N/A'}`
        );
        logger.error(`Token was present: ${!!turnstileToken}`);
        logger.error(`Token length: ${turnstileToken?.length || 0}`);
        logger.error(
            `Secret key configured: ${!!runtimeConfig.turnstile.secretKey}`
        );

        return {
            success: false,
            error: {
                statusCode: 502,
                payload: {
                    error: 'CAPTCHA verification service unavailable',
                    details: 'Please try again later.',
                },
                logLabel: 'reflect captcha-service-error',
            },
        };
    }
};
