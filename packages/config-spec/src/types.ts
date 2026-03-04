/**
 * @description: Shared types for the environment spec and canonical defaults package.
 * @footnote-scope: interface
 * @footnote-module: ConfigSpecTypes
 * @footnote-risk: low - Incorrect typing creates config drift but does not execute behavior directly.
 * @footnote-ethics: medium - These types shape how defaults and operator-facing settings are represented.
 */

export type EnvOwner = 'backend' | 'discord-bot' | 'web' | 'shared';
export type EnvStage = 'runtime' | 'bootstrap' | 'tooling';
export type EnvValueKind =
    | 'string'
    | 'boolean'
    | 'integer'
    | 'number'
    | 'csv'
    | 'enum'
    | 'json';

export type EnvLiteralValue =
    | string
    | number
    | boolean
    | readonly string[]
    | Readonly<Record<string, number>>;

export type EnvDefault =
    | { kind: 'none' }
    | { kind: 'literal'; value: EnvLiteralValue }
    | {
          kind: 'derived';
          description: string;
          fallbackValue?: string | number | boolean;
      }
    | { kind: 'runtime'; description: string };

export type EnvSpecEntry<TDefault extends EnvDefault = EnvDefault> = {
    key: string;
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
