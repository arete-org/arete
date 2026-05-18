/**
 * @description: Resolves the trace token for server-local-node topology with
 * deterministic precedence and persistent fallback token creation.
 * @footnote-scope: utility
 * @footnote-module: TraceTokenResolver
 * @footnote-risk: high - Incorrect token resolution can break server/node auth.
 * @footnote-ethics: medium - Auth material handling affects integrity and trust boundaries.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TRACE_TOKEN_PATH = '/data/secrets/trace-api-token';

const maybe = (value) => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const isPermissionError = (error) =>
    Boolean(error) &&
    typeof error === 'object' &&
    (error.code === 'EACCES' ||
        error.code === 'EPERM' ||
        error.code === 'EROFS');

const isUnsupportedPermissionOperation = (error) =>
    Boolean(error) &&
    typeof error === 'object' &&
    (error.code === 'ENOSYS' || error.code === 'EINVAL');

const tryChmod = async (targetPath, mode) => {
    try {
        await fs.chmod(targetPath, mode);
    } catch (error) {
        if (isUnsupportedPermissionOperation(error)) {
            return;
        }
        throw error;
    }
};

const readTokenFromFile = async (tokenPath) => {
    let content;
    try {
        content = await fs.readFile(tokenPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return undefined;
        }
        throw new Error(
            `Failed to read trace token file at ${tokenPath}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    const token = content.trim();
    if (token.length === 0) {
        throw new Error(
            `Trace token file at ${tokenPath} exists but is empty.`
        );
    }
    return token;
};

const createToken = () => crypto.randomBytes(32).toString('hex');

const persistToken = async (tokenPath, token) => {
    const tokenDir = path.dirname(tokenPath);
    try {
        await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
        await tryChmod(tokenDir, 0o700);
    } catch (error) {
        if (isPermissionError(error)) {
            throw new Error(
                `Trace token directory is not writable (${tokenDir}). Configure TRACE_API_TOKEN or TRACE_API_TOKEN_FILE.`
            );
        }
        throw new Error(
            `Failed to prepare trace token directory (${tokenDir}): ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    try {
        await fs.writeFile(tokenPath, `${token}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        await tryChmod(tokenPath, 0o600);
        return { token, source: 'generated-file' };
    } catch (error) {
        if (error?.code === 'EEXIST') {
            const existingToken = await readTokenFromFile(tokenPath);
            if (!existingToken) {
                throw new Error(
                    `Trace token file at ${tokenPath} could not be created and no existing token is available.`
                );
            }
            await tryChmod(tokenPath, 0o600);
            return { token: existingToken, source: 'existing-file' };
        }
        if (isPermissionError(error)) {
            throw new Error(
                `Trace token file path is not writable (${tokenPath}). Configure TRACE_API_TOKEN or TRACE_API_TOKEN_FILE.`
            );
        }
        throw new Error(
            `Failed to write trace token file (${tokenPath}): ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
};

const resolveTraceToken = async ({
    env = process.env,
    defaultTokenPath = DEFAULT_TRACE_TOKEN_PATH,
} = {}) => {
    const envToken = maybe(env.TRACE_API_TOKEN);
    if (envToken) {
        return {
            token: envToken,
            source: 'env',
            path: undefined,
        };
    }

    const tokenPath = maybe(env.TRACE_API_TOKEN_FILE) || defaultTokenPath;
    const existingToken = await readTokenFromFile(tokenPath);
    if (existingToken) {
        await tryChmod(tokenPath, 0o600);
        return {
            token: existingToken,
            source: 'existing-file',
            path: tokenPath,
        };
    }

    const persisted = await persistToken(tokenPath, createToken());
    return {
        token: persisted.token,
        source: persisted.source,
        path: tokenPath,
    };
};

const formatTraceTokenSourceLog = (result) =>
    `TRACE_TOKEN_SOURCE=${result.source}${result.path ? ` path=${result.path}` : ''}`;

export {
    DEFAULT_TRACE_TOKEN_PATH,
    formatTraceTokenSourceLog,
    resolveTraceToken,
};
