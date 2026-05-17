/**
 * @description: Covers shared prompt registry loading, override behavior, and canonical chat prompt availability.
 * @footnote-scope: test
 * @footnote-module: SharedPromptRegistryTests
 * @footnote-risk: medium - Missing tests here can let backend and bot prompt ownership drift again.
 * @footnote-ethics: high - Canonical prompt defaults must stay stable and fail open when overrides break.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { createPromptRegistry } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, '..', '..', '..');

test('loads shared conversational prompts plus surface supplements', () => {
    const registry = createPromptRegistry();

    assert.equal(registry.hasPrompt('conversation.shared.system'), true);
    assert.equal(
        registry.hasPrompt('conversation.shared.persona.footnote'),
        true
    );
    assert.equal(registry.hasPrompt('chat.web.system'), true);
    assert.equal(registry.hasPrompt('chat.web.persona.footnote'), true);
    assert.equal(registry.hasPrompt('chat.review.assess.system'), true);
    assert.equal(registry.hasPrompt('chat.review.refine.system'), true);
    assert.equal(
        registry.hasPrompt('chat.review.module.concise_answer.assess'),
        true
    );
    assert.equal(
        registry.hasPrompt('chat.review.module.natural_human_style.refine'),
        true
    );
    assert.equal(registry.hasPrompt('discord.image.persona.footnote'), true);
    assert.equal(registry.hasPrompt('discord.realtime.persona.footnote'), true);
    assert.match(
        registry.renderPrompt('conversation.shared.system', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /You are the response engine for a configured Footnote assistant\./
    );
    assert.match(
        registry.renderPrompt('chat.web.system', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /CITATION STYLE/
    );
    assert.match(
        registry.renderPrompt('conversation.shared.persona.footnote', {
            botProfileDisplayName: 'Footnote',
        }).content,
        /You are Footnote, part of the Footnote project\./
    );
});

test('loads all review prompt keys and each key renders non-empty content', () => {
    const registry = createPromptRegistry();
    const reviewPromptKeys = [
        'chat.review.assess.system',
        'chat.review.refine.system',
        'chat.review.module.concise_answer.assess',
        'chat.review.module.concise_answer.refine',
        'chat.review.module.natural_human_style.assess',
        'chat.review.module.natural_human_style.refine',
    ] as const;

    for (const key of reviewPromptKeys) {
        assert.equal(registry.hasPrompt(key), true);
        const rendered = registry.renderPrompt(key).content.trim();
        assert.equal(rendered.length > 0, true);
    }
});

test('merges override files over the canonical defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override.yaml');
    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  chat:',
                '    system:',
                '      template: |-',
                '        Override chat prompt.',
            ].join('\n'),
            'utf8'
        );

        const registry = createPromptRegistry({ overridePath });

        assert.equal(
            registry.renderPrompt('discord.chat.system').content,
            'Override chat prompt.'
        );
        assert.match(
            registry.renderPrompt('chat.web.persona.footnote', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /In web chat, favor explicit reasoning/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('missing override files fail open to defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'missing-override.yaml');
    const warnings: Array<Record<string, unknown>> = [];
    try {
        const registry = createPromptRegistry({
            overridePath,
            logger: {
                warn(message, meta) {
                    warnings.push({ message, ...(meta ?? {}) });
                },
            },
        });

        assert.match(
            registry.renderPrompt('discord.chat.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /Formatting and citations:/
        );
        assert.equal(warnings.length, 1);
        assert.match(
            String(warnings[0].message),
            /Ignoring prompt override file/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('invalid override entries are warned and skipped while valid entries still apply', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-prompts-'));
    const overridePath = path.join(tempDir, 'override-invalid.yaml');
    const warnings: Array<Record<string, unknown>> = [];
    try {
        fs.writeFileSync(
            overridePath,
            [
                'discord:',
                '  chat:',
                '    system:',
                '      template: 123',
                '  image:',
                '    system:',
                '      template: |-',
                '        Invalid cache override',
                '      cache: not-an-object',
                'chat:',
                '  web:',
                '    system:',
                '      template: |-',
                '        Web chat override prompt.',
                'unknown:',
                '  chat:',
                '    system:',
                '      template: |-',
                '        Unknown key prompt.',
            ].join('\n'),
            'utf8'
        );

        const registry = createPromptRegistry({
            overridePath,
            logger: {
                warn(message, meta) {
                    warnings.push({ message, ...(meta ?? {}) });
                },
            },
        });

        assert.equal(
            registry.renderPrompt('chat.web.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            'Web chat override prompt.'
        );
        assert.match(
            registry.renderPrompt('discord.chat.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /Formatting and citations:/
        );
        assert.match(
            registry.renderPrompt('discord.image.system', {
                botProfileDisplayName: 'Footnote',
            }).content,
            /You are the image-generation orchestration system for a configured Discord bot profile\./
        );
        assert.ok(
            warnings.some(
                (warning) =>
                    String(warning.message) ===
                    'Ignoring invalid prompt override entry.'
            )
        );
        assert.ok(
            warnings.some(
                (warning) =>
                    String(warning.message) ===
                    'Ignoring unknown prompt override key.'
            )
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('unknown prompt keys throw a descriptive error', () => {
    const registry = createPromptRegistry();

    assert.throws(
        () => registry.getPrompt('unknown.prompt.key' as never),
        /Prompt not found for key: unknown\.prompt\.key/
    );
});

test('legacy backend and discord default prompt files are gone', () => {
    const legacyBackendDefaultsPath = path.resolve(
        repoRoot,
        'packages',
        'backend',
        'src',
        'services',
        'prompts',
        'defaults.yaml'
    );
    const legacyDiscordDefaultsPath = path.resolve(
        repoRoot,
        'packages',
        'discord-bot',
        'src',
        'utils',
        'prompts',
        'defaults.yaml'
    );

    assert.equal(fs.existsSync(legacyBackendDefaultsPath), false);
    assert.equal(fs.existsSync(legacyDiscordDefaultsPath), false);
});

test('chat planner TRACE rubric is rendered from traceTemperamentContract defaults', () => {
    const registry = createPromptRegistry();
    const renderedPlannerPrompt = registry.renderPrompt(
        'chat.planner.system'
    ).content;

    assert.match(renderedPlannerPrompt, /default posture anchor: 3/);
    assert.match(
        renderedPlannerPrompt,
        /tightness 1: expansive and loose; no compression pressure; best for exploratory or reflective exchanges/
    );
    assert.match(
        renderedPlannerPrompt,
        /extent 5: broad option framing with explicit comparison; best for high-stakes trade-off evaluation/
    );
    const tightness1Index = renderedPlannerPrompt.indexOf('tightness 1:');
    const extent1Index = renderedPlannerPrompt.indexOf('extent 1:');
    const tightness2Index = renderedPlannerPrompt.indexOf('tightness 2:');
    assert.ok(tightness1Index > -1);
    assert.ok(extent1Index > tightness1Index);
    assert.ok(tightness2Index > extent1Index);
});

test('traceTemperamentContract defaults include canonical anchor axes and levels', () => {
    // Dual strategy: this test parses defaults.yaml directly to validate source
    // data integrity (anchor, axes, levels), while the planner-render test
    // verifies runtime consumption/rendering through PromptRegistry.
    const defaultsPath = path.resolve(
        testDirectory,
        '..',
        'src',
        'defaults.yaml'
    );
    const parsed = yaml.load(fs.readFileSync(defaultsPath, 'utf8')) as Record<
        string,
        unknown
    >;
    const contract = parsed.traceTemperamentContract as
        | {
              defaultAnchor?: number;
              axes?: unknown[];
              levels?: Record<string, Record<string, unknown>>;
          }
        | undefined;

    assert.ok(contract);
    assert.equal(contract?.defaultAnchor, 3);
    assert.deepEqual(contract?.axes, [
        'tightness',
        'rationale',
        'attribution',
        'caution',
        'extent',
    ]);
    for (const level of ['1', '2', '3', '4', '5'] as const) {
        const levelMap: Record<string, unknown> | undefined =
            contract?.levels?.[level];
        assert.ok(levelMap);
        assert.equal(typeof levelMap?.tightness, 'string');
        assert.equal(typeof levelMap?.rationale, 'string');
        assert.equal(typeof levelMap?.attribution, 'string');
        assert.equal(typeof levelMap?.caution, 'string');
        assert.equal(typeof levelMap?.extent, 'string');
    }
});
