// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * @description: Verifies workflow-engine transition and limit invariants used by backend orchestration.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineTests
 * @footnote-risk: medium - Missing coverage can allow transition or budget regressions in shared orchestration logic.
 * @footnote-ethics: high - Workflow bounds and legality checks enforce auditable, fail-open-safe model control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyStepExecutionToState,
    buildPlannerStepRecord,
    createInitialWorkflowState,
    isWorkflowTransitionAllowed,
    checkExecutionLimits,
    mapLimitExhaustionToTerminationReason,
    runBoundedReviewWorkflow,
    type ExecutionLimits,
    type WorkflowRunPolicy,
} from '../../src/services/workflowEngine.js';
import type {
    GenerationRuntime,
    RuntimeMessage,
} from '@footnote/agent-runtime';
import type { ConversationContextEnvelope } from '../../src/services/conversationContextService.js';

const permissivePolicy: WorkflowRunPolicy = {
    enablePlanning: true,
    enableToolUse: true,
    enableReplanning: true,
    enableAssessment: true,
    enableRevision: true,
};

const strictPolicy: WorkflowRunPolicy = {
    enablePlanning: false,
    enableToolUse: false,
    enableReplanning: false,
    enableAssessment: false,
    enableRevision: false,
};

const createLimits = (): ExecutionLimits => ({
    maxWorkflowSteps: 5,
    maxToolCalls: 2,
    maxDeliberationCalls: 3,
    maxTokensTotal: 100,
    maxDurationMs: 1000,
});

const TEST_CONTEXT_ENVELOPE: ConversationContextEnvelope = {
    participants: [],
    turns: [],
    diagnostics: {
        surface: 'web',
        totalInputMessages: 0,
        projectedMessageCount: 0,
        trimmedMessageCount: 0,
        sanitizedTimestampCount: 0,
        projectedSpeakerLabelCount: 0,
    },
};

const runBoundedReviewWorkflowForTest = (
    input: Omit<
        Parameters<typeof runBoundedReviewWorkflow>[0],
        'contextEnvelope'
    > & {
        contextEnvelope?: ConversationContextEnvelope;
    }
): ReturnType<typeof runBoundedReviewWorkflow> =>
    runBoundedReviewWorkflow({
        ...input,
        contextEnvelope: input.contextEnvelope ?? TEST_CONTEXT_ENVELOPE,
    });

test('workflowEngine remains policy/runtime neutral and avoids orchestrator policy imports', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const workflowEngineSource = readFileSync(
        join(testDir, '..', 'src', 'services', 'workflowEngine.ts'),
        'utf8'
    );
    assert.equal(
        workflowEngineSource.includes(
            "from './chatOrchestrator/plannerResultApplier"
        ),
        false
    );
    assert.equal(
        workflowEngineSource.includes(
            "from './chatOrchestrator/profileResolution"
        ),
        false
    );
    assert.equal(workflowEngineSource.includes("from './chatPlanner"), false);
});
