/**
 * @description: Covers planner normalization and repo-explainer search wiring for Discord chat.
 * @footnote-scope: test
 * @footnote-module: PlannerWebSearchIntentTests
 * @footnote-risk: low - These tests only verify deterministic planner and prompt helpers.
 * @footnote-ethics: medium - Repo explanation behavior affects how clearly Ari represents Footnote to users.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { Planner, type Plan } from '../src/utils/prompting/Planner.js';
import { buildRepoExplainerResponseHint } from '../src/utils/MessageProcessor.js';
import {
    buildRepoExplainerQuery,
    buildWebSearchInstruction,
} from '../src/utils/openaiService.js';

function normalizePlan(plan: Partial<Plan>): Plan {
    const planner = new Planner({} as never);
    const validatePlan = Reflect.get(planner as object, 'validatePlan') as (
        candidate: Partial<Plan>
    ) => Plan;

    return validatePlan.call(planner, plan);
}

test('validatePlan normalizes repo_explainer hints and upgrades context size', () => {
    const plan = normalizePlan({
        action: 'message',
        modality: 'text',
        riskTier: 'Low',
        openaiOptions: {
            reasoningEffort: 'low',
            verbosity: 'low',
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'How does Discord provenance work in Footnote?',
                searchIntent: 'repo_explainer',
                repoHints: ['Discord', 'provenance', 'discord', 'wiki'] as never,
                searchContextSize: 'low',
            },
        },
    });

    assert.equal(plan.openaiOptions.webSearch?.searchIntent, 'repo_explainer');
    assert.equal(plan.openaiOptions.webSearch?.searchContextSize, 'medium');
    assert.deepEqual(plan.openaiOptions.webSearch?.repoHints, [
        'discord',
        'provenance',
    ]);
});

test('validatePlan falls back to current_facts when searchIntent is invalid', () => {
    const plan = normalizePlan({
        action: 'message',
        modality: 'text',
        riskTier: 'Low',
        openaiOptions: {
            reasoningEffort: 'low',
            verbosity: 'low',
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'What changed in pnpm recently?',
                searchIntent: 'repo' as never,
                searchContextSize: 'low',
            },
        },
    });

    assert.equal(plan.openaiOptions.webSearch?.searchIntent, 'current_facts');
    assert.equal(plan.openaiOptions.webSearch?.searchContextSize, 'low');
    assert.deepEqual(plan.openaiOptions.webSearch?.repoHints, []);
});

test('validatePlan disables web_search when the normalized query is blank', () => {
    const plan = normalizePlan({
        action: 'message',
        modality: 'text',
        riskTier: 'Low',
        openaiOptions: {
            reasoningEffort: 'low',
            verbosity: 'low',
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: '   ',
                searchIntent: 'repo_explainer',
                repoHints: ['discord', 'provenance'],
                searchContextSize: 'medium',
            },
        },
    });

    assert.equal(plan.openaiOptions.tool_choice, 'none');
    assert.equal(plan.openaiOptions.webSearch, undefined);
});

test('validatePlan clears web search state for image actions', () => {
    const plan = normalizePlan({
        action: 'image',
        modality: 'tts',
        riskTier: 'Low',
        imageRequest: {
            prompt: 'draw a lighthouse in fog',
        },
        openaiOptions: {
            reasoningEffort: 'low',
            verbosity: 'low',
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'Footnote lighthouse concept art',
                searchIntent: 'repo_explainer',
                repoHints: ['discord'] as never,
                searchContextSize: 'medium',
            },
        },
    });

    assert.equal(plan.modality, 'text');
    assert.equal(plan.openaiOptions.tool_choice, 'none');
    assert.equal(plan.openaiOptions.webSearch, undefined);
});

test('buildWebSearchInstruction keeps current_facts generic', () => {
    const instruction = buildWebSearchInstruction({
        query: 'latest OpenAI policy update',
        searchIntent: 'current_facts',
    });

    assert.equal(
        instruction,
        'The planner instructed you to perform a web search for: latest OpenAI policy update'
    );
});

test('buildWebSearchInstruction prefers DeepWiki for repo explainers', () => {
    const instruction = buildWebSearchInstruction({
        query: 'Footnote Discord provenance flow',
        searchIntent: 'repo_explainer',
        repoHints: ['discord', 'provenance'],
    });

    assert.match(instruction, /DeepWiki/);
    assert.match(instruction, /footnote-ai\/footnote/);
    assert.match(instruction, /Focus areas: discord, provenance/);
});

test('buildRepoExplainerQuery anchors repo searches to the canonical repo identity', () => {
    const query = buildRepoExplainerQuery({
        query: 'tell me about your onboarding process',
        searchIntent: 'repo_explainer',
        repoHints: ['onboarding'],
    });

    assert.match(query, /footnote-ai\/footnote/);
    assert.match(query, /DeepWiki/);
    assert.match(query, /onboarding/);
    assert.match(query, /getting started/);
});

test('buildRepoExplainerResponseHint only appears for repo-explainer message plans', () => {
    const repoHint = buildRepoExplainerResponseHint({
        action: 'message',
        openaiOptions: {
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'Footnote architecture overview',
                searchIntent: 'repo_explainer',
            },
        },
    });

    const factHint = buildRepoExplainerResponseHint({
        action: 'message',
        openaiOptions: {
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'latest OpenAI policy update',
                searchIntent: 'current_facts',
            },
        },
    });

    const imageHint = buildRepoExplainerResponseHint({
        action: 'image',
        openaiOptions: {
            tool_choice: { type: 'web_search' },
            webSearch: {
                query: 'Footnote art direction',
                searchIntent: 'repo_explainer',
            },
        },
    });

    assert.match(repoHint ?? '', /Footnote repo-explanation lookup/);
    assert.equal(factHint, null);
    assert.equal(imageHint, null);
});

test('mirrored planner prompts stay aligned and remove repoQuery guidance', () => {
    const backendPromptPath = path.resolve(
        'packages/backend/src/services/prompts/defaults.yaml'
    );
    const discordPromptPath = path.resolve(
        'packages/discord-bot/src/utils/prompts/defaults.yaml'
    );

    const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n');
    const backendPrompt = normalizeNewlines(
        fs.readFileSync(backendPromptPath, 'utf8')
    );
    const discordPrompt = normalizeNewlines(
        fs.readFileSync(discordPromptPath, 'utf8')
    );
    const extractPlannerSection = (content: string) => {
        const match = content.match(
            /\n {4}planner:\n[\s\S]*?\n {4}summarizer:\n/
        );

        return match?.[0] ?? '';
    };
    const backendPlannerSection = extractPlannerSection(backendPrompt);
    const discordPlannerSection = extractPlannerSection(discordPrompt);

    assert.equal(backendPlannerSection, discordPlannerSection);
    assert.equal(backendPlannerSection.includes('repoQuery'), false);
    assert.equal(backendPlannerSection.includes('searchIntent'), true);
    assert.equal(backendPlannerSection.includes('repoHints'), true);
    assert.equal(backendPlannerSection.includes('footnote-ai/footnote'), true);
    assert.equal(
        backendPlannerSection.includes('refer to your docs'),
        true
    );
});
