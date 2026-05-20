#!/usr/bin/env node
/* eslint-env node */
/* global URL */

/**
 * @description: Centralized local development port defaults and env-driven resolution helpers.
 * @footnote-scope: utility
 * @footnote-module: DevPortPolicy
 * @footnote-risk: medium - Incorrect defaults or parsing can misroute local backend/web startup.
 * @footnote-ethics: low - Developer-only configuration policy with no direct user-impact decisions.
 */
const DEFAULT_FOOTNOTE_BASE_PORT = 6683; // "NOTE" on a phone keypad
const DEFAULT_WEBHOOK_PORT = 3001;
const DEFAULT_WEB_BASE_URL_PORT = 8080;
const MAX_PORT = 65535;

const parsePort = (value) => {
    if (!value) {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_PORT) {
        return undefined;
    }

    return parsed;
};

const portFromUrl = (value) => {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (!url.port) {
            return undefined;
        }
        return parsePort(url.port);
    } catch {
        return undefined;
    }
};

const resolveFootnoteBasePort = (env = process.env) =>
    parsePort(env.FOOTNOTE_BASE_PORT) ?? DEFAULT_FOOTNOTE_BASE_PORT;

const resolveBackendPort = (env = process.env) => resolveFootnoteBasePort(env);

const resolveWebPort = (
    env = process.env,
    basePort = resolveFootnoteBasePort(env)
) =>
    parsePort(env.FOOTNOTE_WEB_PORT) ??
    (basePort < MAX_PORT ? basePort + 1 : DEFAULT_FOOTNOTE_BASE_PORT);

const resolveWebhookPort = (env = process.env) =>
    parsePort(env.WEBHOOK_PORT) ?? DEFAULT_WEBHOOK_PORT;

const resolvePreflightWebPort = (env = process.env) => {
    const basePort = resolveFootnoteBasePort(env);
    return (
        parsePort(env.FOOTNOTE_WEB_PORT) ??
        portFromUrl(env.WEB_BASE_URL) ??
        (basePort < MAX_PORT ? basePort + 1 : DEFAULT_WEB_BASE_URL_PORT)
    );
};

module.exports = {
    DEFAULT_FOOTNOTE_BASE_PORT,
    DEFAULT_WEB_BASE_URL_PORT,
    MAX_PORT,
    parsePort,
    portFromUrl,
    resolveBackendPort,
    resolveFootnoteBasePort,
    resolvePreflightWebPort,
    resolveWebPort,
    resolveWebhookPort,
};
