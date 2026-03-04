/**
 * @description: Builds Cloudflare Turnstile verification config.
 * @footnote-scope: utility
 * @footnote-module: BackendTurnstileSection
 * @footnote-risk: medium - Wrong Turnstile config can disable abuse checks or reject valid users.
 * @footnote-ethics: medium - CAPTCHA configuration affects access, friction, and fairness.
 */

import {
    parseHostnameListEnv,
    parseOptionalTrimmedString,
} from '../parsers.js';
import type { RuntimeConfig, WarningSink } from '../types.js';

export const buildTurnstileSection = (
    env: NodeJS.ProcessEnv,
    _warn: WarningSink
): RuntimeConfig['turnstile'] => {
    const secretKey = parseOptionalTrimmedString(env.TURNSTILE_SECRET_KEY);
    const siteKey = parseOptionalTrimmedString(env.TURNSTILE_SITE_KEY);

    return {
        secretKey,
        siteKey,
        allowedHostnames: parseHostnameListEnv(
            env.TURNSTILE_ALLOWED_HOSTNAMES,
            []
        ),
        enabled: Boolean(secretKey && siteKey),
    };
};
