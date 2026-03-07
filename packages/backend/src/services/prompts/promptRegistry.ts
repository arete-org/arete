/**
 * @description: Binds the shared prompt package to backend runtime configuration.
 * @footnote-scope: utility
 * @footnote-module: BackendPromptRegistry
 * @footnote-risk: medium - Wrong binding here can desync backend prompt overrides from the canonical catalog.
 * @footnote-ethics: high - Backend prompt selection shapes canonical reflect behavior and provenance rules.
 */

import {
    createPromptRegistry,
    type CreatePromptRegistryOptions,
    type PromptKey,
    type PromptRegistry,
    type PromptVariables,
    type RenderedPrompt,
} from '@footnote/prompts';
import { runtimeConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';

const promptLogger =
    typeof logger.child === 'function'
        ? logger.child({ module: 'backendPromptRegistry' })
        : logger;

type PromptRegistryLogger = NonNullable<CreatePromptRegistryOptions['logger']>;
type PromptRegistryLoggerMethod = NonNullable<PromptRegistryLogger['info']>;
type PromptRegistryLogMeta = Parameters<PromptRegistryLoggerMethod>[1];

const promptRegistryLogger: NonNullable<CreatePromptRegistryOptions['logger']> = {
    info(message: string, meta?: PromptRegistryLogMeta) {
        promptLogger.info(message, meta);
    },
    warn(message: string, meta?: PromptRegistryLogMeta) {
        promptLogger.warn(message, meta);
    },
    error(message: string, meta?: PromptRegistryLogMeta) {
        promptLogger.error(message, meta);
    },
};

export const createBackendPromptRegistry = (
    options: Partial<CreatePromptRegistryOptions> = {}
): PromptRegistry =>
    createPromptRegistry({
        overridePath:
            options.overridePath ??
            runtimeConfig.runtime.promptConfigPath ??
            undefined,
        logger: options.logger ?? promptRegistryLogger,
    });

export const promptRegistry: PromptRegistry = createBackendPromptRegistry();

export const renderPrompt = (
    key: PromptKey,
    variables: PromptVariables = {}
): RenderedPrompt => promptRegistry.renderPrompt(key, variables);
