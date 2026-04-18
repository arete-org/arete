/**
 * @description: Shared JSON response helpers for the chat HTTP handler.
 * @footnote-scope: utility
 * @footnote-module: ChatResponses
 * @footnote-risk: medium - Response formatting mistakes can change API status codes or payloads.
 * @footnote-ethics: medium - Consistent error payloads help clients interpret failures clearly.
 */
import type { ServerResponse } from 'node:http';
import type { ApiErrorResponse } from '@footnote/contracts/web';

export type JsonHeaders = Record<string, string>;

export type ChatFailureResponse = {
    statusCode: number;
    payload: ApiErrorResponse;
    logLabel: string;
    extraHeaders?: JsonHeaders;
};

export const PROVIDER_UNAVAILABLE_DETAILS = 'provider_unavailable' as const;

/**
 * Standard error payload for routes that depend on a generation provider.
 * `details` stays stable so clients can branch on one reason code.
 */
export const buildProviderUnavailableError = (
    message: string
): ApiErrorResponse => ({
    error: message,
    details: PROVIDER_UNAVAILABLE_DETAILS,
});

/**
 * Small shared helper so every chat response uses the same JSON headers.
 * Keeping this in one place makes later status/payload changes less error-prone.
 */
export const sendJson = (
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
    extraHeaders?: JsonHeaders
): void => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    if (extraHeaders) {
        for (const [header, value] of Object.entries(extraHeaders)) {
            res.setHeader(header, value);
        }
    }

    res.end(JSON.stringify(payload));
};
