/**
 * @description: Resolves backend-owned chat persona overlay and display-name settings.
 * @footnote-scope: core
 * @footnote-module: ChatProfileOverlay
 * @footnote-risk: high - Incorrect persona routing can apply the wrong identity instructions across deployments.
 * @footnote-ethics: high - Persona identity selection directly affects user trust and disclosure clarity.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { BotProfileConfig } from '../config/profile.js';
import { buildProfileOverlaySystemMessage } from './prompts/profilePromptOverlay.js';
import { runtimeConfig } from '../config.js';

type ChatProfileOverlayLogger = {
    warn: (
        message: string,
        meta?: {
            requestedProfileId?: string;
            runtimeProfileId: string;
            surface: PostChatRequest['surface'];
            requestedPersonaId?: string;
            resolvedPersonaId?: string;
            overlayPath?: string;
        }
    ) => void;
};

type PersonaCatalogEntry = {
    id: string;
    displayName: string;
    overlayRelativePath: string | null;
};

const PERSONA_CATALOG: Record<string, PersonaCatalogEntry> = {
    footnote: {
        id: 'footnote',
        displayName: 'Footnote',
        overlayRelativePath: null,
    },
    myuri: {
        id: 'myuri',
        displayName: 'Myuri',
        overlayRelativePath: 'packages/prompts/src/profile-overlays/myuri.md',
    },
    danny: {
        id: 'danny',
        displayName: 'Danny',
        overlayRelativePath: 'packages/prompts/src/profile-overlays/danny.md',
    },
};

const DEFAULT_PERSONA_ID = 'footnote';

const resolvePersonaEntry = (
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): PersonaCatalogEntry => {
    if (request.surface !== 'discord') {
        return PERSONA_CATALOG[DEFAULT_PERSONA_ID];
    }

    const requestedPersonaId = request.botPersonaId?.trim().toLowerCase();
    if (!requestedPersonaId) {
        return PERSONA_CATALOG[DEFAULT_PERSONA_ID];
    }

    const matchedPersona = PERSONA_CATALOG[requestedPersonaId];
    if (matchedPersona) {
        return matchedPersona;
    }

    logger.warn('chat request selected unknown botPersonaId; using fallback', {
        runtimeProfileId: runtimeConfig.profile.id,
        surface: request.surface,
        requestedPersonaId,
        resolvedPersonaId: DEFAULT_PERSONA_ID,
    });
    return PERSONA_CATALOG[DEFAULT_PERSONA_ID];
};

const readPersonaOverlayText = (
    persona: PersonaCatalogEntry,
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): { text: string | null; absolutePath: string | null } => {
    if (!persona.overlayRelativePath) {
        return { text: null, absolutePath: null };
    }

    const absolutePath = path.resolve(
        runtimeConfig.runtime.projectRoot,
        persona.overlayRelativePath
    );
    try {
        const overlayText = fs.readFileSync(absolutePath, 'utf-8').trim();
        if (overlayText.length === 0) {
            logger.warn(
                'persona overlay file was empty; using fallback without overlay',
                {
                    runtimeProfileId: runtimeConfig.profile.id,
                    surface: request.surface,
                    requestedPersonaId: request.botPersonaId,
                    resolvedPersonaId: persona.id,
                    overlayPath: absolutePath,
                }
            );
            return { text: null, absolutePath };
        }

        return { text: overlayText, absolutePath };
    } catch {
        logger.warn(
            'persona overlay file could not be read; using fallback without overlay',
            {
                runtimeProfileId: runtimeConfig.profile.id,
                surface: request.surface,
                requestedPersonaId: request.botPersonaId,
                resolvedPersonaId: persona.id,
                overlayPath: absolutePath,
            }
        );
        return { text: null, absolutePath };
    }
};

const buildPersonaProfileConfig = (
    persona: PersonaCatalogEntry,
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): BotProfileConfig => {
    const overlay = readPersonaOverlayText(persona, request, logger);
    return {
        id: persona.id,
        displayName: persona.displayName,
        mentionAliases: [],
        promptOverlay: {
            source: overlay.text ? 'file' : 'none',
            text: overlay.text,
            path: overlay.absolutePath,
            length: overlay.text?.length ?? 0,
        },
    };
};

export const resolveChatPersonaProfile = (
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): BotProfileConfig =>
    buildPersonaProfileConfig(
        resolvePersonaEntry(request, logger),
        request,
        logger
    );

/**
 * Uses the shared profile display-name env so non-overlay persona templates
 * resolve to the same name operators configured for the deployment.
 */
export const resolveBotProfileDisplayName = (
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): string => resolveChatPersonaProfile(request, logger).displayName;

/**
 * Persona overlay selection is backend-owned and tied to runtime bot profile.
 * Request profile selection is handled separately by chat orchestrator routing.
 */
export const resolveActiveProfileOverlayPrompt = (
    request: Pick<PostChatRequest, 'surface' | 'botPersonaId'>,
    logger: ChatProfileOverlayLogger
): string | null => {
    return buildProfileOverlaySystemMessage(
        resolveChatPersonaProfile(request, logger),
        'chat'
    );
};
