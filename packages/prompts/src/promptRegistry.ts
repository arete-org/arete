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
} from './types.js';
import { promptKeys } from './types.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const knownPromptKeys = new Set<PromptKey>(promptKeys);

type PromptMap = Partial<Record<PromptKey, PromptDefinition>>;

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
): string =>
    template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, key) => {
        const raw = variables[key];
        if (raw === undefined || raw === null) {
            return '';
        }
        return typeof raw === 'string' ? raw : String(raw);
    });

const isPromptKey = (value: string): value is PromptKey =>
    knownPromptKeys.has(value as PromptKey);

class SharedPromptRegistry implements PromptRegistry {
    private readonly prompts: PromptMap;

    constructor(options: CreatePromptRegistryOptions = {}) {
        const defaults = loadPromptFile(resolveBundledDefaultsPath(), false);
        const merged: PromptMap = { ...defaults };

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
                return;
            }
            try {
                const overrideData = loadPromptFile(resolvedOverridePath, true);
                Object.assign(merged, overrideData);
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
        const content = interpolateTemplate(definition.template, variables);
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

const loadPromptFile = (filePath: string, optional: boolean): PromptMap => {
    const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
        if (optional) {
            return {};
        }
        throw new Error(
            `Prompt configuration file not found: ${resolvedPath}`
        );
    }

    const fileContents = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = yaml.load(fileContents);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(
            `Prompt configuration did not parse to an object: ${resolvedPath}`
        );
    }

    return flattenPromptTree(parsed as Record<string, unknown>);
};

const flattenPromptTree = (
    tree: Record<string, unknown>,
    prefix = ''
): PromptMap => {
    const result: PromptMap = {};

    for (const [segment, value] of Object.entries(tree)) {
        const key = prefix ? `${prefix}.${segment}` : segment;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const candidate = value as Record<string, unknown>;
            const template = candidate.template ?? candidate.prompt;

            if (typeof template === 'string' && isPromptKey(key)) {
                result[key] = {
                    template,
                    description:
                        typeof candidate.description === 'string'
                            ? candidate.description
                            : undefined,
                    cache:
                        typeof candidate.cache === 'object' &&
                        candidate.cache !== null
                            ? (candidate.cache as PromptCachePolicy)
                            : undefined,
                };
                continue;
            }

            Object.assign(result, flattenPromptTree(candidate, key));
        }
    }

    return result;
};

export const createPromptRegistry = (
    options: CreatePromptRegistryOptions = {}
): PromptRegistry => new SharedPromptRegistry(options);
