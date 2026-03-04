/**
 * @description: Shared types for the environment spec and canonical defaults package.
 * @footnote-scope: interface
 * @footnote-module: ConfigSpecTypes
 * @footnote-risk: low - Incorrect typing creates config drift but does not execute behavior directly.
 * @footnote-ethics: medium - These types shape how defaults and operator-facing settings are represented.
 */

/**
 * Package or surface that owns a given env variable.
 */
export type EnvOwner = 'backend' | 'discord-bot' | 'web' | 'shared';
/**
 * Lifecycle stage when the env value is expected to exist.
 */
export type EnvStage = 'runtime' | 'bootstrap' | 'tooling';
/**
 * Normalized value kind used by docs and config tooling.
 */
export type EnvValueKind =
    | 'string'
    | 'boolean'
    | 'integer'
    | 'number'
    | 'csv'
    | 'enum'
    | 'json';

/**
 * Literal values that can be represented directly in the generated default map.
 */
export type EnvLiteralValue =
    | string
    | number
    | boolean
    | readonly string[]
    | Readonly<Record<string, number>>;

/**
 * Supported ways of describing an env default in the shared spec.
 */
export type EnvDefault =
    | { kind: 'none' }
    | { kind: 'literal'; value: EnvLiteralValue }
    | {
          kind: 'derived';
          description: string;
          fallbackValue?: string | number | boolean;
      }
    | { kind: 'runtime'; description: string };

/**
 * One environment variable declaration in the shared config spec.
 */
export type EnvSpecEntry<TDefault extends EnvDefault = EnvDefault> = {
    key: string;
    isPattern?: true;
    owner: EnvOwner;
    stage: EnvStage;
    section: string;
    required: boolean;
    secret: boolean;
    kind: EnvValueKind;
    description: string;
    defaultValue: TDefault;
    allowedValues?: readonly string[];
    example?: string;
    notes?: readonly string[];
    usedBy: readonly string[];
};
