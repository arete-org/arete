/**
 * @arete-module: PromptRegistry
 * @arete-risk: moderate
 * @arete-ethics: high
 * @arete-scope: utility
 *
 * @description: Manages prompt templates and rendering for AI interactions. Handles prompt loading, caching, and variable substitution.
 *
 * @impact
 * Risk: Template errors can break AI interactions or cause unexpected behavior. Manages prompt lifecycle and variable interpolation.
 * Ethics: Controls the prompts that shape AI behavior and responses, directly affecting the ethical framing and guidance provided to the AI.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Literal union of every prompt key currently supported. Keeping this list
 * centrally defined ensures compile-time safety for all consumers.
 */
export type PromptKey =
  | 'discord.chat.system'
  | 'discord.image.system'
  | 'discord.image.developer'
  | 'discord.realtime.system'
  | 'discord.planner.system'
  | 'discord.summarizer.system'
  | 'discord.news.system';

/**
 * Tracks metadata used by downstream systems (for example cache hints). The
 * structure intentionally remains flexible so that future policies can be added
 * without needing to cascade type updates throughout the repo.
 */
export interface PromptCachePolicy {
  strategy?: string;
  ttlSeconds?: number;
  [key: string]: unknown;
}

/**
 * Canonical description of a prompt entry once loaded from YAML.
 */
export interface PromptMetadata {
  description?: string;
  cache?: PromptCachePolicy;
}

export interface PromptDefinition extends PromptMetadata {
  template: string;
}

/**
 * Variables that may be interpolated into prompt templates. All values are
 * coerced to strings, with `null`/`undefined` becoming an empty string.
 */
export type PromptVariables = Record<string, string | number | boolean | null | undefined>;

/**
 * Result returned after interpolation. Keeping the metadata available allows
 * callers to forward cache hints alongside the resolved prompt body.
 */
export interface RenderedPrompt extends PromptMetadata {
  content: string;
}

export interface PromptRegistryOptions {
  /** Optional override file path, typically driven by the PROMPT_CONFIG_PATH env var. */
  overridePath?: string;
}

/**
 * Internal helper type to keep strong typing over the flattened prompt map.
 */
type PromptMap = Partial<Record<PromptKey, PromptDefinition>>;

/**
 * Cache of known prompt keys for quick lookup and runtime validation.
 */
const KNOWN_PROMPT_KEYS = new Set<PromptKey>([
  'discord.chat.system',
  'discord.image.system',
  'discord.image.developer',
  'discord.realtime.system',
  'discord.planner.system',
  'discord.summarizer.system',
  'discord.news.system'
]);

/**
 * Tiny helper that converts `file:` URLs into absolute filesystem paths. Using
 * URL utilities keeps the implementation compatible whether we execute from the
 * TypeScript source or the compiled JavaScript output.
 */
const resolveRelativePath = (target: string): string => {
  return path.resolve(__dirname, target);
};

/**
 * Performs a simple `{{placeholder}}` substitution. The routine is intentionally
 * light-weight: it does not implement conditionals or loops, only flat
 * replacements so that prompts remain readable for non-engineers editing YAML.
 */
const interpolateTemplate = (template: string, variables: PromptVariables): string => {
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_match, key) => {
    const raw = variables[key];
    if (raw === undefined || raw === null) {
      return '';
    }
    if (typeof raw === 'string') {
      return raw;
    }
    return String(raw);
  });
};

/**
 * PromptRegistry is the single source of truth for loading, merging, and
 * retrieving prompt templates. It understands both the built-in defaults and an
 * optional operator-supplied override file.
 */
export class PromptRegistry {
  private readonly prompts: PromptMap;

  constructor(options: PromptRegistryOptions = {}) {
    const defaults = this.loadPromptFile(
      resolveRelativePath('../../../src/shared/prompts/defaults.yaml'),
      false
    );
    const merged: PromptMap = { ...defaults };

    if (options.overridePath) {
      const overrideData = this.loadPromptFile(options.overridePath, true);
      Object.assign(merged, overrideData);
    }

    this.prompts = merged;
  }

  /**
   * Retrieves a prompt definition or throws a descriptive error if missing.
   */
  public getPrompt(key: PromptKey): PromptDefinition {
    const prompt = this.prompts[key];
    if (!prompt) {
      throw new Error(`Prompt not found for key: ${key}`);
    }
    return prompt;
  }

  /**
   * Convenience wrapper that resolves a prompt and performs interpolation.
   */
  public renderPrompt(key: PromptKey, variables: PromptVariables = {}): RenderedPrompt {
    const definition = this.getPrompt(key);
    const content = interpolateTemplate(definition.template, variables);
    return {
      content,
      description: definition.description,
      cache: definition.cache
    };
  }

  /**
   * Indicates whether a prompt is defined. Useful for lightweight startup
   * assertions without forcing interpolation.
   */
  public hasPrompt(key: PromptKey): boolean {
    return Boolean(this.prompts[key]);
  }

  /**
   * Ensures that each requested key has a corresponding definition. This is
   * handy for startup checks so operators immediately know if their overrides
   * omitted any high-severity prompts.
   */
  public assertKeys(keys: PromptKey[]): void {
    for (const key of keys) {
      if (!this.hasPrompt(key)) {
        throw new Error(`Missing prompt definition for key: ${key}`);
      }
    }
  }

  /**
   * Loads and flattens a YAML prompt file into the internal map representation.
   */
  private loadPromptFile(filePath: string, optional: boolean): PromptMap {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      if (optional) {
        return {};
      }
      throw new Error(`Prompt configuration file not found: ${resolvedPath}`);
    }

    const fileContents = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = yaml.load(fileContents);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Prompt configuration did not parse to an object: ${resolvedPath}`);
    }

    return this.flattenPromptTree(parsed as Record<string, unknown>);
  }

  /**
   * Recursively walks a nested object structure, producing dot-delimited keys
   * that match the PromptKey union.
   */
  private flattenPromptTree(tree: Record<string, unknown>, prefix = ''): PromptMap {
    const result: PromptMap = {};

    for (const [segment, value] of Object.entries(tree)) {
      const key = prefix ? `${prefix}.${segment}` : segment;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const candidate = value as Record<string, unknown>;
        const template = candidate.template ?? candidate.prompt;

        if (typeof template === 'string' && isPromptKey(key)) {
          result[key] = {
            template,
            description: typeof candidate.description === 'string' ? candidate.description : undefined,
            cache: typeof candidate.cache === 'object' && candidate.cache !== null
              ? (candidate.cache as PromptCachePolicy)
              : undefined
          };
          continue;
        }

        Object.assign(result, this.flattenPromptTree(candidate, key));
      }
    }

    return result;
  }
}

/**
 * Runtime guard used while flattening the YAML tree.
 */
const isPromptKey = (value: string): value is PromptKey => KNOWN_PROMPT_KEYS.has(value as PromptKey);

/**
 * Holds onto the active registry instance so that callers can use the
 * functional `renderPrompt` helper without threading references everywhere.
 */
let activePromptRegistry: PromptRegistry | null = null;

/**
 * Registers the singleton prompt registry for downstream helpers. Typically
 * invoked from the Discord bot's environment bootstrap after loading overrides.
 */
export const setActivePromptRegistry = (registry: PromptRegistry): void => {
  activePromptRegistry = registry;
};

/**
 * Retrieves the currently configured registry or throws a helpful error when
 * it has not yet been initialised.
 */
export const getActivePromptRegistry = (): PromptRegistry => {
  if (!activePromptRegistry) {
    throw new Error('Prompt registry has not been initialised. Call setActivePromptRegistry() first.');
  }
  return activePromptRegistry;
};

/**
 * Convenience wrapper preferred by many call-sites. It simply defers to the
 * configured registry while keeping metadata in the response.
 */
export const renderPrompt = (key: PromptKey, variables: PromptVariables = {}): RenderedPrompt => {
  return getActivePromptRegistry().renderPrompt(key, variables);
};

// Initialise the module-level registry with the built-in defaults so that unit
// tests or lightweight scripts can call renderPrompt without explicitly
// bootstrapping the environment. Deployment code can overwrite this singleton
// by invoking setActivePromptRegistry with a custom instance (for example, one
// that incorporates operator overrides).
if (!activePromptRegistry) {
  activePromptRegistry = new PromptRegistry();
}

