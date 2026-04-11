/**
 * @description: Defines one shared observability envelope for steerability
 * control input, decision, and outcome records across orchestration paths.
 * @footnote-scope: core
 * @footnote-module: SteerabilityControlObservability
 * @footnote-risk: medium - Inconsistent envelope fields can reduce auditability and hide control drift.
 * @footnote-ethics: high - Missing control lineage can mislead operators about what shaped an answer.
 */
import type {
    ExecutionReasonCode,
    ExecutionStatus,
    PlannerExecutionApplyOutcome,
    SteerabilityControlId,
    SteerabilityControls,
    ToolInvocationRequest,
    WorkflowModeDecision,
} from '@footnote/contracts/ethics-core';
import type { PostChatRequest } from '@footnote/contracts/web';

type ControlObservabilityLogger = {
    info: (entry: Record<string, unknown>) => void;
};

export type ControlObservabilityEnvelope = {
    version: 'v1';
    input: {
        surface: PostChatRequest['surface'];
        workflowModeId: WorkflowModeDecision['modeId'];
        executionContractResponseMode: 'fast_direct' | 'quality_grounded';
        requestedProfileId: string | null;
        plannerSelectedProfileId: string | null;
        selectedProfileId: string;
        personaOverlaySource: 'none' | 'inline' | 'file';
        toolRequest: {
            toolName: ToolInvocationRequest['toolName'];
            requested: boolean;
            eligible: boolean;
            reasonCode: ToolInvocationRequest['reasonCode'] | null;
        };
    };
    decision: {
        plannerApplyOutcome: PlannerExecutionApplyOutcome;
        plannerMatteredControlIds: SteerabilityControlId[];
        controls: SteerabilityControls['controls'];
    };
    outcome: {
        responseAction: 'message' | 'ignore' | 'react' | 'image';
        responseModality: 'text' | 'tts';
        plannerStatus: ExecutionStatus;
        plannerReasonCode: ExecutionReasonCode | null;
        mattered: boolean;
    };
};

const REQUIRED_CONTROL_OBSERVABILITY_FIELDS: readonly string[] = [
    'version',
    'input.surface',
    'input.workflowModeId',
    'input.executionContractResponseMode',
    'input.requestedProfileId',
    'input.plannerSelectedProfileId',
    'input.selectedProfileId',
    'input.personaOverlaySource',
    'input.toolRequest.toolName',
    'input.toolRequest.requested',
    'input.toolRequest.eligible',
    'decision.plannerApplyOutcome',
    'decision.plannerMatteredControlIds',
    'decision.controls',
    'outcome.responseAction',
    'outcome.responseModality',
    'outcome.plannerStatus',
    'outcome.mattered',
];

const REQUIRED_CONTROL_OBSERVABILITY_INPUT_FIELDS: readonly string[] = [
    'surface',
    'workflowModeId',
    'executionContractResponseMode',
    'requestedProfileId',
    'plannerSelectedProfileId',
    'selectedProfileId',
    'personaOverlaySource',
    'toolRequest.toolName',
    'toolRequest.requested',
    'toolRequest.eligible',
    'plannerApplyOutcome',
    'plannerMatteredControlIds',
    'plannerStatus',
    'responseAction',
    'responseModality',
    'steerabilityControls.controls',
];

const NULLABLE_REQUIRED_CONTROL_OBSERVABILITY_FIELDS = new Set<string>([
    'input.requestedProfileId',
    'input.plannerSelectedProfileId',
    'requestedProfileId',
    'plannerSelectedProfileId',
]);

const getValueByPath = (
    source: Record<string, unknown>,
    path: string
): unknown =>
    path.split('.').reduce<unknown>((current, segment) => {
        if (!current || typeof current !== 'object') {
            return undefined;
        }

        return (current as Record<string, unknown>)[segment];
    }, source);

const hasRequiredValue = (value: unknown): boolean => {
    if (value === undefined || value === null) {
        return false;
    }

    if (typeof value === 'string') {
        return value.trim().length > 0;
    }

    if (Array.isArray(value)) {
        return true;
    }

    return true;
};

const hasRequiredValueAtPath = (path: string, value: unknown): boolean => {
    if (
        value === null &&
        NULLABLE_REQUIRED_CONTROL_OBSERVABILITY_FIELDS.has(path)
    ) {
        return true;
    }

    return hasRequiredValue(value);
};

export const listMissingControlObservabilityFields = (
    envelope: ControlObservabilityEnvelope
): string[] => {
    const envelopeRecord = envelope as unknown as Record<string, unknown>;
    const missing: string[] = [];
    for (const requiredField of REQUIRED_CONTROL_OBSERVABILITY_FIELDS) {
        const value = getValueByPath(envelopeRecord, requiredField);
        if (!hasRequiredValueAtPath(requiredField, value)) {
            missing.push(requiredField);
        }
    }

    return missing;
};

const listMissingControlObservabilityInputFields = (
    input: Record<string, unknown>
): string[] => {
    const missing: string[] = [];
    for (const requiredField of REQUIRED_CONTROL_OBSERVABILITY_INPUT_FIELDS) {
        const value = getValueByPath(input, requiredField);
        if (!hasRequiredValueAtPath(requiredField, value)) {
            missing.push(requiredField);
        }
    }

    return missing;
};

export const buildControlObservabilityEnvelope = (input: {
    surface: PostChatRequest['surface'];
    workflowModeId: WorkflowModeDecision['modeId'];
    executionContractResponseMode: 'fast_direct' | 'quality_grounded';
    requestedProfileId?: string;
    plannerSelectedProfileId?: string;
    selectedProfileId: string;
    personaOverlaySource: 'none' | 'inline' | 'file';
    toolRequest: ToolInvocationRequest;
    plannerApplyOutcome: PlannerExecutionApplyOutcome;
    plannerMatteredControlIds: SteerabilityControlId[];
    plannerStatus: ExecutionStatus;
    plannerReasonCode?: ExecutionReasonCode;
    responseAction: 'message' | 'ignore' | 'react' | 'image';
    responseModality: 'text' | 'tts';
    steerabilityControls: SteerabilityControls;
}): ControlObservabilityEnvelope => {
    const trimToNull = (value: string | undefined): string | null => {
        const trimmed = value?.trim();
        return trimmed && trimmed.length > 0 ? trimmed : null;
    };
    const normalizedInput = {
        ...input,
        requestedProfileId: trimToNull(input.requestedProfileId),
        plannerSelectedProfileId: trimToNull(input.plannerSelectedProfileId),
    } as Record<string, unknown>;
    const missingInputFields =
        listMissingControlObservabilityInputFields(normalizedInput);
    if (missingInputFields.length > 0) {
        throw new Error(
            `Control observability input missing required fields: ${missingInputFields.join(', ')}`
        );
    }
    const envelope: ControlObservabilityEnvelope = {
        version: 'v1',
        input: {
            surface: input.surface,
            workflowModeId: input.workflowModeId,
            executionContractResponseMode: input.executionContractResponseMode,
            requestedProfileId: normalizedInput.requestedProfileId as
                | string
                | null,
            plannerSelectedProfileId:
                normalizedInput.plannerSelectedProfileId as string | null,
            selectedProfileId: input.selectedProfileId,
            personaOverlaySource: input.personaOverlaySource,
            toolRequest: {
                toolName: input.toolRequest.toolName,
                requested: input.toolRequest.requested,
                eligible: input.toolRequest.eligible,
                reasonCode: input.toolRequest.reasonCode ?? null,
            },
        },
        decision: {
            plannerApplyOutcome: input.plannerApplyOutcome,
            plannerMatteredControlIds: input.plannerMatteredControlIds,
            controls: input.steerabilityControls.controls,
        },
        outcome: {
            responseAction: input.responseAction,
            responseModality: input.responseModality,
            plannerStatus: input.plannerStatus,
            plannerReasonCode: input.plannerReasonCode ?? null,
            mattered: input.plannerMatteredControlIds.length > 0,
        },
    };

    const missingFields = listMissingControlObservabilityFields(envelope);
    if (missingFields.length > 0) {
        throw new Error(
            `Control observability envelope missing required fields: ${missingFields.join(', ')}`
        );
    }

    return envelope;
};

export const emitControlObservabilityEnvelope = (
    targetLogger: ControlObservabilityLogger,
    envelope: ControlObservabilityEnvelope
): void => {
    targetLogger.info({
        event: 'chat.steerability.control_observability',
        controlObservability: envelope,
    });
};
