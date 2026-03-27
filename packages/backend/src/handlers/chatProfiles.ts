/**
 * @description: Serves enabled chat model profile options for bot/runtime consumers.
 * @footnote-scope: interface
 * @footnote-module: ChatProfilesHandler
 * @footnote-risk: medium - Bad filtering can expose disabled profiles or hide valid routing options.
 * @footnote-ethics: medium - Accurate profile visibility supports transparent model selection.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GetChatProfilesResponse } from '@footnote/contracts/web';
import { runtimeConfig } from '../config.js';

type LogRequest = (
    req: IncomingMessage,
    res: ServerResponse,
    extra?: string
) => void;

const DESCRIPTION_MAX_LENGTH = 120;
const CACHE_CONTROL_HEADER = 'public, max-age=60';

/**
 * Truncates descriptions so slash-command labels stay concise and predictable.
 */
const truncateDescription = (description: string): string => {
    const trimmed = description.trim();
    if (trimmed.length <= DESCRIPTION_MAX_LENGTH) {
        return trimmed;
    }

    return `${trimmed.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}...`;
};

/**
 * Builds a public-safe profile option list from the runtime catalog.
 * Only enabled entries are returned.
 */
const buildEnabledProfileOptions = (): GetChatProfilesResponse['profiles'] =>
    runtimeConfig.modelProfiles.catalog
        .filter((profile) => profile.enabled)
        .map((profile) => ({
            id: profile.id,
            ...(profile.description.trim().length > 0
                ? {
                      description: truncateDescription(profile.description),
                  }
                : {}),
        }));

/**
 * @api.operationId: getChatProfiles
 * @api.path: GET /api/chat/profiles
 */
export const createChatProfilesHandler =
    ({ logRequest }: { logRequest: LogRequest }) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            logRequest(req, res, 'chat-profiles method-not-allowed');
            return;
        }

        try {
            const payload: GetChatProfilesResponse = {
                profiles: buildEnabledProfileOptions(),
            };
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', CACHE_CONTROL_HEADER);
            res.end(JSON.stringify(payload));
            logRequest(
                req,
                res,
                `chat-profiles ok count=${payload.profiles.length}`
            );
        } catch (error) {
            // Fail open: return an empty list so startup/registration can continue.
            const payload: GetChatProfilesResponse = { profiles: [] };
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(payload));
            logRequest(
                req,
                res,
                `chat-profiles fallback-empty error=${error instanceof Error ? error.message : String(error)}`
            );
        }
    };
