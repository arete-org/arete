/**
 * @description: Ensures workflow engine remains runtime-policy neutral at module boundary.
 * @footnote-scope: test
 * @footnote-module: WorkflowEngineBoundaryTests
 * @footnote-risk: medium - Boundary drift can couple engine to orchestration layers.
 * @footnote-ethics: high - Separation supports auditable control surfaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
