/**
 * @description: Provides an ON/OFF benchmark harness for prototype conformance and delta measurements.
 * The harness compares adapter OFF, ON, and ON_FAIL modes per case without changing Execution Contract authority semantics.
 * @footnote-scope: utility
 * @footnote-module: ExecutionContractTrustGraphBenchmarkHarness
 * @footnote-risk: medium - Benchmark wiring errors can hide regressions or overstate adapter impact.
 * @footnote-ethics: medium - Reliable benchmark evidence supports transparent governance decisions.
 */

import { runEvidenceIngestion } from './trustGraphEvidenceIngestion.js';
import { StubTrustGraphEvidenceAdapter } from './trustGraphEvidenceAdapter.js';
import type {
    LocalTerminalOutcome,
    ScopeTuple,
} from './trustGraphEvidenceTypes.js';
import {
    TrustGraphOwnershipBypassCapability,
    TrustGraphOwnershipValidationPolicy,
} from './trustGraphEvidenceTypes.js';

export type TrustGraphBenchmarkCase = {
    caseId: string;
    caseType:
        | 'straightforward'
        | 'sparse'
        | 'conflicting'
        | 'scope_failure'
        | 'timeout'
        | 'verification_required'
        | 'baseline_succeeds'
        | 'adversarial';
    queryIntent: string;
    scopeTuple: ScopeTuple;
    expectedLocalTerminalOutcome: LocalTerminalOutcome;
};

export type TrustGraphBenchmarkMode = 'OFF' | 'ON' | 'ON_FAIL';

export type TrustGraphBenchmarkRow = {
    caseId: string;
    caseType: TrustGraphBenchmarkCase['caseType'];
    adapterMode: TrustGraphBenchmarkMode;
    scopeResult: 'ok' | 'denied';
    evidenceBundleReceived: 'yes' | 'no';
    traceCompletenessDeltaVsBaseline: number;
    coverageDeltaVsBaseline: number;
    verificationRequired: 'yes' | 'no';
    terminalOutcome: LocalTerminalOutcome;
    outcomeExplanation: string;
    conformanceFailures: string[];
};

const countTraceCompleteness = (traceRefs: string[]): number =>
    traceRefs.length;

const readCoverageValue = (value: number | undefined): number =>
    value === undefined ? 0 : value;

const runCaseForMode = async (
    benchmarkCase: TrustGraphBenchmarkCase,
    mode: TrustGraphBenchmarkMode
): Promise<TrustGraphBenchmarkRow> => {
    const sharedInput = {
        queryIntent: benchmarkCase.queryIntent,
        scopeTuple: benchmarkCase.scopeTuple,
        budget: {
            timeoutMs: 30,
            maxCalls: 1,
        },
        ownershipValidationPolicy:
            TrustGraphOwnershipValidationPolicy.explicitlyNoneForNonProduction({
                policyId: 'benchmark_harness_policy',
                justificationCode: 'benchmark_harness',
                bypassCapability:
                    TrustGraphOwnershipBypassCapability.forBenchmarkHarness(),
            }),
        evaluateLocalExecutionContractOutcome: () =>
            benchmarkCase.expectedLocalTerminalOutcome,
    };

    const baselineResult = await runEvidenceIngestion(sharedInput);
    const baselineTraceCompleteness = countTraceCompleteness(
        baselineResult.predicateViews.P_EVID.traceRefs
    );
    const baselineCoverage = readCoverageValue(
        baselineResult.predicateViews.P_SUFF.coverageValue
    );

    const adapter =
        mode === 'ON'
            ? new StubTrustGraphEvidenceAdapter('success')
            : mode === 'ON_FAIL'
              ? new StubTrustGraphEvidenceAdapter(
                    benchmarkCase.caseType === 'timeout' ? 'timeout' : 'failure'
                )
              : undefined;

    const runResult = await runEvidenceIngestion({
        ...sharedInput,
        adapter,
    });

    const currentTraceCompleteness = countTraceCompleteness(
        runResult.predicateViews.P_EVID.traceRefs
    );
    const currentCoverage = readCoverageValue(
        runResult.predicateViews.P_SUFF.coverageValue
    );

    const conformanceFailures: string[] = [];
    if (runResult.terminalAuthority !== 'backend_execution_contract') {
        conformanceFailures.push('terminal_authority_changed');
    }
    if (runResult.failOpenBehavior !== 'local_behavior') {
        conformanceFailures.push('fail_open_behavior_changed');
    }
    if (!runResult.verificationRequired) {
        conformanceFailures.push('verification_was_suppressed');
    }

    return {
        caseId: benchmarkCase.caseId,
        caseType: benchmarkCase.caseType,
        adapterMode: mode,
        scopeResult: runResult.scopeValidation.ok ? 'ok' : 'denied',
        evidenceBundleReceived:
            runResult.advisoryEvidenceItemCount > 0 ? 'yes' : 'no',
        traceCompletenessDeltaVsBaseline:
            currentTraceCompleteness - baselineTraceCompleteness,
        coverageDeltaVsBaseline: Number(
            (currentCoverage - baselineCoverage).toFixed(4)
        ),
        verificationRequired: runResult.verificationRequired ? 'yes' : 'no',
        terminalOutcome: runResult.localTerminalOutcome,
        outcomeExplanation:
            runResult.adapterStatus === 'success'
                ? 'Adapter evidence ingested through governed fields.'
                : 'Local fail-open Execution Contract behavior used.',
        conformanceFailures,
    };
};

export const runBenchmarkTriplet = async (
    benchmarkCase: TrustGraphBenchmarkCase
): Promise<TrustGraphBenchmarkRow[]> => [
    await runCaseForMode(benchmarkCase, 'OFF'),
    await runCaseForMode(benchmarkCase, 'ON'),
    await runCaseForMode(benchmarkCase, 'ON_FAIL'),
];
