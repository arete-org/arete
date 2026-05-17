/**
 * @description: Loads and renders the canonical prompt catalog shared by backend and Discord runtimes.
 * @footnote-scope: utility
 * @footnote-module: SharedPromptRegistry
 * @footnote-risk: high - Prompt loading failures here can break multiple user-facing surfaces at once.
 * @footnote-ethics: high - Shared prompts shape safety, attribution, and transparency across the product.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import type {
    CreatePromptRegistryOptions,
    PromptCachePolicy,
    PromptDefinition,
    PromptKey,
    PromptRegistry,
    PromptVariables,
    RenderedPrompt,
    TraceTemperamentAxisKey,
    TraceTemperamentContract,
    TraceTemperamentLevel,
} from './types.js';
import { promptKeys } from './types.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const knownPromptKeys = new Set<PromptKey>(promptKeys);

type PromptMap = Partial<Record<PromptKey, PromptDefinition>>;
const TRACE_TEMPERAMENT_LEVELS: readonly TraceTemperamentLevel[] = [
    '1',
    '2',
    '3',
    '4',
    '5',
] as const;
const TRACE_TEMPERAMENT_AXES: readonly TraceTemperamentAxisKey[] = [
    'tightness',
    'rationale',
    'attribution',
    'caution',
    'extent',
] as const;
const TRACE_TEMPERAMENT_RUBRIC_TEMPLATE_VARIABLE = 'trace_temperament_rubric';
const TRACE_TEMPERAMENT_DEFAULT_TEMPLATE_VARIABLE =
    'trace_temperament_default_anchor';
/**
 * Validation mode used while loading prompt catalogs.
 * - strict: throw on invalid prompt node shape (used for canonical defaults)
 * - warn-and-skip: log and continue (used for operator override files)
 */
type PromptValidationMode = 'strict' | 'warn-and-skip';
type PromptValidationContext = {
    sourcePath: string;
    mode: PromptValidationMode;
    logger?: CreatePromptRegistryOptions['logger'];
};

const resolveRelativePath = (target: string): string =>
    path.resolve(currentDirectory, target);

const resolveAbsolutePath = (target: string): string =>
    path.isAbsolute(target) ? target : path.resolve(target);

const resolveBundledDefaultsPath = (): string => {
    const candidates = [
        resolveRelativePath('./defaults.yaml'),
        resolveRelativePath('../src/defaults.yaml'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return candidates[0];
};

const interpolateTemplate = (
    template: string,
    variables: PromptVariables
): string => {
    let index = 0;
    let rendered = '';

    while (index < template.length) {
        const start = template.indexOf('{{', index);
        if (start === -1) {
            rendered += template.slice(index);
            break;
        }

        rendered += template.slice(index, start);

        const end = template.indexOf('}}', start + 2);
        if (end === -1) {
            rendered += template.slice(start);
            break;
        }

        const key = template.slice(start + 2, end).trim();
        if (key.length === 0 || key.includes('{') || key.includes('}')) {
            rendered += template.slice(start, end + 2);
            index = end + 2;
            continue;
        }

        // Differentiate missing variables from explicit `undefined`
        // Check ownership before substituting
        const hasVariable = Object.prototype.hasOwnProperty.call(
            variables,
            key
        );
        if (!hasVariable) {
            rendered += template.slice(start, end + 2);
        } else {
            const raw = variables[key];
            if (raw !== undefined && raw !== null) {
                rendered += typeof raw === 'string' ? raw : String(raw);
            }
        }

        index = end + 2;
    }

    return rendered;
};

const isPromptKey = (value: string): value is PromptKey =>
    knownPromptKeys.has(value as PromptKey);

/**
 * Applies full-key replacement semantics for prompt definitions.
 * Override keys replace entire prompt definitions, and keys not present in the
 * override keep their default definitions.
 */
const mergePromptCatalog = (
    baseCatalog: PromptMap,
    overrideCatalog: PromptMap
): PromptMap => {
    const mergedCatalog: PromptMap = { ...baseCatalog };
    for (const [key, definition] of Object.entries(overrideCatalog) as Array<
        [PromptKey, PromptDefinition]
    >) {
        mergedCatalog[key] = definition;
    }
    return mergedCatalog;
};

/**
 * Emits validation issues according to the chosen mode.
 * Strict mode throws for invalid data, while warn-and-skip mode logs and keeps
 * loading so runtime behavior stays fail-open.
 */
const reportPromptValidationIssue = (
    context: PromptValidationContext,
    message: string,
    meta: Record<string, unknown>
): void => {
    if (context.mode === 'strict') {
        throw new Error(
            `${message} (source: ${context.sourcePath}, key: ${String(meta.promptKey ?? 'unknown')}, reason: ${String(meta.reason ?? 'n/a')})`
        );
    }

    context.logger?.warn?.(message, {
        sourcePath: context.sourcePath,
        ...meta,
    });
};

class SharedPromptRegistry implements PromptRegistry {
    private readonly prompts: PromptMap;
    private readonly globalTemplateVariables: PromptVariables;

    constructor(options: CreatePromptRegistryOptions = {}) {
        // Shared prompt resolution order:
        // 1) bundled defaults
        // 2) optional PROMPT_CONFIG_PATH-style overrides (full key replacement)
        const defaultsLoadResult = loadPromptFile(
            resolveBundledDefaultsPath(),
            {
                optional: false,
                mode: 'strict',
                logger: options.logger,
            }
        );
        let merged = defaultsLoadResult.prompts;
        let traceTemperamentContract =
            defaultsLoadResult.traceTemperamentContract;

        if (options.overridePath) {
            const resolvedOverridePath = resolveAbsolutePath(
                options.overridePath
            );
            if (!fs.existsSync(resolvedOverridePath)) {
                options.logger?.warn?.(
                    'Ignoring prompt override file because it does not exist.',
                    {
                        overridePath: resolvedOverridePath,
                    }
                );
                this.prompts = merged;
                this.globalTemplateVariables =
                    traceTemperamentContract === undefined
                        ? {}
                        : {
                              [TRACE_TEMPERAMENT_DEFAULT_TEMPLATE_VARIABLE]:
                                  traceTemperamentContract.defaultAnchor,
                              [TRACE_TEMPERAMENT_RUBRIC_TEMPLATE_VARIABLE]:
                                  renderTraceTemperamentRubric(
                                      traceTemperamentContract
                                  ),
                          };
                return;
            }
            try {
                const overrideLoadResult = loadPromptFile(
                    resolvedOverridePath,
                    {
                        optional: true,
                        mode: 'warn-and-skip',
                        logger: options.logger,
                    }
                );
                merged = mergePromptCatalog(merged, overrideLoadResult.prompts);
                if (overrideLoadResult.traceTemperamentContract) {
                    traceTemperamentContract =
                        overrideLoadResult.traceTemperamentContract;
                }
            } catch (error) {
                options.logger?.warn?.(
                    'Ignoring prompt override file due to load failure.',
                    {
                        overridePath: resolvedOverridePath,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }
                );
            }
        }

        this.prompts = merged;
        this.globalTemplateVariables =
            traceTemperamentContract === undefined
                ? {}
                : {
                      [TRACE_TEMPERAMENT_DEFAULT_TEMPLATE_VARIABLE]:
                          traceTemperamentContract.defaultAnchor,
                      [TRACE_TEMPERAMENT_RUBRIC_TEMPLATE_VARIABLE]:
                          renderTraceTemperamentRubric(
                              traceTemperamentContract
                          ),
                  };
    }

    public getPrompt(key: PromptKey): PromptDefinition {
        const prompt = this.prompts[key];
        if (!prompt) {
            throw new Error(`Prompt not found for key: ${key}`);
        }
        return prompt;
    }

    public renderPrompt(
        key: PromptKey,
        variables: PromptVariables = {}
    ): RenderedPrompt {
        const definition = this.getPrompt(key);
        const content = interpolateTemplate(definition.template, {
            ...variables,
            ...this.globalTemplateVariables,
        });
        return {
            content,
            description: definition.description,
            cache: definition.cache,
        };
    }

    public hasPrompt(key: PromptKey): boolean {
        return Boolean(this.prompts[key]);
    }

    public assertKeys(keys: readonly PromptKey[]): void {
        for (const key of keys) {
            if (!this.hasPrompt(key)) {
                throw new Error(`Missing prompt definition for key: ${key}`);
            }
        }
    }
}

/**
 * Loads one YAML prompt file and flattens it into PromptKey -> PromptDefinition entries.
 */
const loadPromptFile = (
    filePath: string,
    options: {
        optional: boolean;
        mode: PromptValidationMode;
        logger?: CreatePromptRegistryOptions['logger'];
    }
): {
    prompts: PromptMap;
    traceTemperamentContract?: TraceTemperamentContract;
} => {
    const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        if (options.optional) {
            return { prompts: {} };
        }
        throw new Error(`Prompt configuration file not found: ${resolvedPath}`);
    }

    const fileContents = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = yaml.load(fileContents);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(
            `Prompt configuration did not parse to an object: ${resolvedPath}`
        );
    }

    const parsedRoot = parsed as Record<string, unknown>;
    return {
        prompts: flattenPromptTree(parsedRoot, {
            sourcePath: resolvedPath,
            mode: options.mode,
            logger: options.logger,
        }),
        traceTemperamentContract: parseTraceTemperamentContract(
            parsedRoot.traceTemperamentContract,
            {
                sourcePath: resolvedPath,
                mode: options.mode,
                logger: options.logger,
            }
        ),
    };
};

const parseTraceTemperamentContract = (
    value: unknown,
    context: PromptValidationContext
): TraceTemperamentContract | undefined => {
    if (value === undefined) {
        if (context.mode === 'strict') {
            reportPromptValidationIssue(
                context,
                'Missing required trace temperament contract entry.',
                {
                    promptKey: 'traceTemperamentContract',
                    reason: 'traceTemperamentContract is required in strict mode',
                }
            );
        }
        return undefined;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reportPromptValidationIssue(
            context,
            'Ignoring invalid trace temperament contract entry.',
            {
                promptKey: 'traceTemperamentContract',
                reason: 'traceTemperamentContract must be an object',
            }
        );
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    if (candidate.defaultAnchor !== 3) {
        reportPromptValidationIssue(
            context,
            'Ignoring invalid trace temperament contract entry.',
            {
                promptKey: 'traceTemperamentContract.defaultAnchor',
                reason: 'defaultAnchor must be 3',
            }
        );
        return undefined;
    }

    const axesRaw = candidate.axes;
    if (
        !Array.isArray(axesRaw) ||
        axesRaw.length !== TRACE_TEMPERAMENT_AXES.length ||
        !TRACE_TEMPERAMENT_AXES.every((axis, index) => axesRaw[index] === axis)
    ) {
        reportPromptValidationIssue(
            context,
            'Ignoring invalid trace temperament contract entry.',
            {
                promptKey: 'traceTemperamentContract.axes',
                reason: 'axes must be [tightness, rationale, attribution, caution, extent] in canonical order',
            }
        );
        return undefined;
    }

    const levelsRaw = candidate.levels;
    if (
        !levelsRaw ||
        typeof levelsRaw !== 'object' ||
        Array.isArray(levelsRaw)
    ) {
        reportPromptValidationIssue(
            context,
            'Ignoring invalid trace temperament contract entry.',
            {
                promptKey: 'traceTemperamentContract.levels',
                reason: 'levels must be an object',
            }
        );
        return undefined;
    }

    const levelsCandidate = levelsRaw as Record<string, unknown>;
    const levels = {} as TraceTemperamentContract['levels'];
    for (const level of TRACE_TEMPERAMENT_LEVELS) {
        const levelRaw = levelsCandidate[level];
        if (
            !levelRaw ||
            typeof levelRaw !== 'object' ||
            Array.isArray(levelRaw)
        ) {
            reportPromptValidationIssue(
                context,
                'Ignoring invalid trace temperament contract entry.',
                {
                    promptKey: `traceTemperamentContract.levels.${level}`,
                    reason: 'each level must be an object',
                }
            );
            return undefined;
        }
        const levelCandidate = levelRaw as Record<string, unknown>;
        const axisMap = {} as Record<TraceTemperamentAxisKey, string>;
        for (const axis of TRACE_TEMPERAMENT_AXES) {
            const axisText = levelCandidate[axis];
            if (typeof axisText !== 'string' || axisText.trim().length === 0) {
                reportPromptValidationIssue(
                    context,
                    'Ignoring invalid trace temperament contract entry.',
                    {
                        promptKey: `traceTemperamentContract.levels.${level}.${axis}`,
                        reason: 'axis text must be a non-empty string',
                    }
                );
                return undefined;
            }
            axisMap[axis] = axisText.trim();
        }
        levels[level] = axisMap;
    }

    return {
        defaultAnchor: 3,
        axes: [...TRACE_TEMPERAMENT_AXES],
        levels,
    };
};

const renderTraceTemperamentRubric = (
    contract: TraceTemperamentContract
): string =>
    TRACE_TEMPERAMENT_LEVELS.map((level) => {
        const levelAxes = contract.levels[level];
        return TRACE_TEMPERAMENT_AXES.map(
            (axis) => `${axis} ${level}: ${levelAxes[axis]}`
        ).join('\n');
    }).join('\n');

/**
 * Walks nested YAML prompt trees and extracts valid prompt definitions.
 * Prompt-like nodes with invalid shape are rejected based on the active validation mode.
 */
const flattenPromptTree = (
    tree: Record<string, unknown>,
    context: PromptValidationContext,
    prefix = ''
): PromptMap => {
    let result: PromptMap = {};

    for (const [segment, value] of Object.entries(tree)) {
        const key = prefix ? `${prefix}.${segment}` : segment;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const candidate = value as Record<string, unknown>;
            // Nodes that declare template/prompt are treated as final prompt definitions.
            // Everything else is traversed as a namespace subtree.
            const hasPromptShape =
                Object.prototype.hasOwnProperty.call(candidate, 'template') ||
                Object.prototype.hasOwnProperty.call(candidate, 'prompt');

            if (hasPromptShape) {
                const template = candidate.template ?? candidate.prompt;
                if (typeof template !== 'string') {
                    reportPromptValidationIssue(
                        context,
                        'Ignoring invalid prompt override entry.',
                        {
                            promptKey: key,
                            reason: 'template or prompt must be a string',
                            receivedType:
                                template === null ? 'null' : typeof template,
                        }
                    );
                    continue;
                }

                if (!isPromptKey(key)) {
                    reportPromptValidationIssue(
                        context,
                        'Ignoring unknown prompt override key.',
                        {
                            promptKey: key,
                            reason: 'prompt key is not part of the canonical prompt catalog',
                        }
                    );
                    continue;
                }

                const rawDescription = candidate.description;
                if (
                    rawDescription !== undefined &&
                    typeof rawDescription !== 'string'
                ) {
                    reportPromptValidationIssue(
                        context,
                        'Ignoring invalid prompt override entry.',
                        {
                            promptKey: key,
                            reason: 'description must be a string when provided',
                            receivedType:
                                rawDescription === null
                                    ? 'null'
                                    : typeof rawDescription,
                        }
                    );
                    continue;
                }

                const rawCache = candidate.cache;
                if (
                    rawCache !== undefined &&
                    (typeof rawCache !== 'object' ||
                        rawCache === null ||
                        Array.isArray(rawCache))
                ) {
                    reportPromptValidationIssue(
                        context,
                        'Ignoring invalid prompt override entry.',
                        {
                            promptKey: key,
                            reason: 'cache must be an object when provided',
                            receivedType:
                                rawCache === null ? 'null' : typeof rawCache,
                        }
                    );
                    continue;
                }

                result = mergePromptCatalog(result, {
                    [key]: {
                        template,
                        description: rawDescription,
                        cache: rawCache as PromptCachePolicy | undefined,
                    },
                });
                continue;
            }

            result = mergePromptCatalog(
                result,
                flattenPromptTree(candidate, context, key)
            );
        }
    }

    return result;
};

export const createPromptRegistry = (
    options: CreatePromptRegistryOptions = {}
): PromptRegistry => new SharedPromptRegistry(options);
