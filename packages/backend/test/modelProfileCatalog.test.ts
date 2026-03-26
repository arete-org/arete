/**
 * @description: Covers backend model profile catalog loading and selector resolution behavior.
 * @footnote-scope: test
 * @footnote-module: ModelProfileCatalogTests
 * @footnote-risk: medium - Missing tests could let routing regressions hide until runtime.
 * @footnote-ethics: medium - Catalog capabilities affect retrieval policy and user transparency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelProfile } from '@footnote/contracts';
import { buildModelProfilesSection } from '../src/config/sections/modelProfiles.js';
import { createModelProfileResolver } from '../src/services/modelProfileResolver.js';

const createCatalog = (): ModelProfile[] => [
    {
        id: 'openai-text-fast',
        description: 'Fast profile.',
        provider: 'openai',
        providerModel: 'gpt-5-mini',
        enabled: true,
        tierBindings: ['text-fast'],
        capabilities: {
            canUseSearch: true,
        },
        costClass: 'low',
        latencyClass: 'low',
    },
    {
        id: 'openai-text-quality',
        description: 'Quality profile.',
        provider: 'openai',
        providerModel: 'gpt-5.1',
        enabled: true,
        tierBindings: ['text-quality'],
        capabilities: {
            canUseSearch: true,
        },
        costClass: 'medium',
        latencyClass: 'medium',
    },
];

test('buildModelProfilesSection loads valid catalog YAML with profile defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const yamlPath = path.join(tempDir, 'catalog.yaml');
    fs.writeFileSync(
        yamlPath,
        [
            'profiles:',
            '  - id: openai-text-fast',
            '    description: Fast profile',
            '    provider: openai',
            '    providerModel: gpt-5-mini',
            '    enabled: true',
            '    tierBindings: [text-fast]',
            '    capabilities:',
            '      canUseSearch: true',
        ].join('\n')
    );

    const warnings: string[] = [];
    const section = buildModelProfilesSection(
        {
            MODEL_PROFILE_CATALOG_PATH: yamlPath,
            DEFAULT_PROFILE_ID: 'openai-text-fast',
        },
        process.cwd(),
        (message) => warnings.push(message)
    );

    assert.equal(section.defaultProfileId, 'openai-text-fast');
    assert.equal(section.plannerProfileId, 'openai-text-fast');
    assert.equal(section.catalog.length, 1);
    assert.equal(section.catalog[0]?.providerModel, 'gpt-5-mini');
    assert.equal(section.catalog[0]?.capabilities.canUseSearch, true);
    assert.equal(warnings.length, 0);
});

test('buildModelProfilesSection warns and skips invalid profile entries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const yamlPath = path.join(tempDir, 'catalog.yaml');
    fs.writeFileSync(
        yamlPath,
        [
            'profiles:',
            '  - id: openai-text-fast',
            '    description: Fast profile',
            '    provider: openai',
            '    providerModel: gpt-5-mini',
            '    enabled: true',
            '    tierBindings: [text-fast]',
            '    capabilities:',
            '      canUseSearch: true',
            '  - id: invalid-entry',
            '    description: Invalid profile',
            '    provider: openai',
            '    providerModel: gpt-5.1',
            '    enabled: true',
            '    tierBindings: [text-quality]',
        ].join('\n')
    );

    const warnings: string[] = [];
    const section = buildModelProfilesSection(
        {
            MODEL_PROFILE_CATALOG_PATH: yamlPath,
            DEFAULT_PROFILE_ID: 'openai-text-fast',
            PLANNER_PROFILE_ID: 'openai-text-quality',
        },
        process.cwd(),
        (message) => warnings.push(message)
    );

    assert.equal(section.catalog.length, 1);
    assert.equal(section.plannerProfileId, 'openai-text-quality');
    assert.match(warnings.join('\n'), /Ignoring invalid model profile/i);
});

test('buildModelProfilesSection falls back to bundled defaults when custom catalog structure is malformed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const customPath = path.join(tempDir, 'custom.yaml');
    const bundledPath = path.join(
        tempDir,
        'packages',
        'backend',
        'src',
        'config',
        'model-profiles.defaults.yaml'
    );
    fs.mkdirSync(path.dirname(bundledPath), { recursive: true });

    fs.writeFileSync(customPath, 'notProfiles: true\n');
    fs.writeFileSync(
        bundledPath,
        [
            'profiles:',
            '  - id: openai-text-fast',
            '    description: Bundled fallback profile',
            '    provider: openai',
            '    providerModel: gpt-5-mini',
            '    enabled: true',
            '    tierBindings: [text-fast]',
            '    capabilities:',
            '      canUseSearch: true',
        ].join('\n')
    );

    const warnings: string[] = [];
    const section = buildModelProfilesSection(
        {
            MODEL_PROFILE_CATALOG_PATH: customPath,
            DEFAULT_PROFILE_ID: 'openai-text-fast',
        },
        tempDir,
        (message) => warnings.push(message)
    );

    assert.equal(section.catalog.length, 1);
    assert.equal(section.catalog[0]?.id, 'openai-text-fast');
    assert.match(
        warnings.join('\n'),
        /Using bundled model profile catalog fallback/i
    );
});

test('buildModelProfilesSection reports catalogPath from the source that produced the final catalog', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    const customPath = path.join(tempDir, 'custom.yaml');
    const bundledPath = path.join(
        tempDir,
        'packages',
        'backend',
        'src',
        'config',
        'model-profiles.defaults.yaml'
    );
    fs.mkdirSync(path.dirname(bundledPath), { recursive: true });

    fs.writeFileSync(customPath, 'profiles: not-an-array\n');
    fs.writeFileSync(
        bundledPath,
        [
            'profiles:',
            '  - id: openai-text-fast',
            '    description: Bundled fallback profile',
            '    provider: openai',
            '    providerModel: gpt-5-mini',
            '    enabled: true',
            '    tierBindings: [text-fast]',
            '    capabilities:',
            '      canUseSearch: true',
        ].join('\n')
    );

    const section = buildModelProfilesSection(
        {
            MODEL_PROFILE_CATALOG_PATH: customPath,
            DEFAULT_PROFILE_ID: 'openai-text-fast',
        },
        tempDir,
        () => undefined
    );

    assert.equal(section.catalogPath, bundledPath);
});

test('model profile resolver handles id, tier, and raw selectors with fail-open fallback', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
        [];
    const resolver = createModelProfileResolver({
        catalog: createCatalog(),
        defaultProfileId: 'openai-text-fast',
        legacyDefaultModel: 'gpt-5-mini',
        warn: (warning) => warnings.push(warning),
    });

    assert.equal(
        resolver.resolve('openai-text-quality').providerModel,
        'gpt-5.1'
    );
    assert.equal(resolver.resolve('text-fast').id, 'openai-text-fast');
    assert.equal(resolver.resolve('openai/gpt-5.2').providerModel, 'gpt-5.2');
    assert.equal(resolver.resolve('gpt-5-nano').providerModel, 'gpt-5-nano');
    assert.equal(
        resolver.resolve('gpt-5-nano').capabilities.canUseSearch,
        false
    );
    assert.equal(resolver.resolve('%%%').id, 'openai-text-fast');
    assert.match(
        warnings.map((warning) => warning.message).join('\n'),
        /could not be resolved|falling back/i
    );
});

test('model profile resolver falls back to legacy DEFAULT_MODEL when catalog has no enabled profiles', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
        [];
    const resolver = createModelProfileResolver({
        catalog: [
            {
                ...createCatalog()[0],
                enabled: false,
            },
        ],
        defaultProfileId: 'openai-text-fast',
        legacyDefaultModel: 'gpt-5-mini',
        warn: (warning) => warnings.push(warning),
    });

    const resolved = resolver.resolve();
    assert.equal(resolved.id, 'legacy-default-model');
    assert.equal(resolved.providerModel, 'gpt-5-mini');
    assert.match(
        warnings.map((warning) => warning.message).join('\n'),
        /legacy DEFAULT_MODEL/i
    );
});

test('model profile resolver synthesizes raw profile when multiple enabled catalog entries share provider/model', () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
        [];
    const duplicateCatalog: ModelProfile[] = [
        ...createCatalog(),
        {
            id: 'openai-text-fast-duplicate',
            description: 'Duplicate provider/model profile.',
            provider: 'openai',
            providerModel: 'gpt-5-mini',
            enabled: true,
            tierBindings: [],
            capabilities: {
                canUseSearch: true,
            },
        },
    ];

    const resolver = createModelProfileResolver({
        catalog: duplicateCatalog,
        defaultProfileId: 'openai-text-fast',
        legacyDefaultModel: 'gpt-5-mini',
        warn: (warning) => warnings.push(warning),
    });

    const resolved = resolver.resolve('openai/gpt-5-mini');
    assert.equal(resolved.id, 'raw-openai-gpt-5-mini');
    assert.equal(resolved.provider, 'openai');
    assert.equal(resolved.providerModel, 'gpt-5-mini');
    assert.equal(resolved.capabilities.canUseSearch, false);
    assert.match(
        warnings.map((warning) => warning.message).join('\n'),
        /multiple enabled catalog profiles matched raw selector/i
    );
});
