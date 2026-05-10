/**
 * @description: Mirrors a safe, metadata-only subset of Footnote trace records to Langfuse.
 * @footnote-scope: utility
 * @footnote-module: LangfuseMetadataMirrorExporter
 * @footnote-risk: low - Export failures only affect optional maintainer observability and do not block response execution.
 * @footnote-ethics: medium - External observability export must avoid PII, raw prompts, and Footnote-owned sensitive semantics.
 */
import type { ResponseMetadata } from '@footnote/contracts/policy';
import type { RuntimeConfig } from '../config/types.js';

type WorkflowLike = {
    modeDecision?: {
        modeId?: string;
        selectedBy?: string;
    };
    terminationReason?: string;
    planner?: {
        status?: string;
        contractType?: string;
    };
    fallback?: {
        tier?: string;
        reasons?: string[];
    };
};

type ExecutionEventLike = {
    kind?: string;
    status?: string;
    reasonCode?: string;
};

type ResponseMetadataLike = ResponseMetadata & {
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
    cost?: {
        inputCostUsd?: number;
        outputCostUsd?: number;
        totalCostUsd?: number;
    };
};

const toWorkflowSummary = (
    workflow: ResponseMetadata['workflow'] | undefined
): Record<string, unknown> | undefined => {
    if (workflow === undefined) {
        return undefined;
    }

    const workflowLike = workflow as unknown as WorkflowLike;
    return {
        modeId: workflowLike.modeDecision?.modeId,
        modeSelectedBy: workflowLike.modeDecision?.selectedBy,
        terminationReason: workflowLike.terminationReason,
        plannerStatus: workflowLike.planner?.status,
        plannerContractType: workflowLike.planner?.contractType,
        fallbackTier: workflowLike.fallback?.tier,
        fallbackReasonCount: workflowLike.fallback?.reasons?.length ?? 0,
    };
};

const toExecutionSummary = (
    execution: ResponseMetadata['execution'] | undefined
): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(execution) || execution.length === 0) {
        return undefined;
    }

    return execution.map((event) => {
        const executionLike = event as unknown as ExecutionEventLike;
        return {
            kind: executionLike.kind,
            status: executionLike.status,
            reasonCode: executionLike.reasonCode,
        };
    });
};

const toSafeMirrorMetadata = (
    metadata: ResponseMetadata
): Record<string, unknown> => {
    const metadataLike = metadata as ResponseMetadataLike;
    return {
        responseId: metadata.responseId,
        modelVersion: metadata.modelVersion,
        provenance: metadata.provenance,
        safetyTier: metadata.safetyTier,
        tradeoffCount: metadata.tradeoffCount,
        staleAfter: metadata.staleAfter,
        traceFinalReasonCode: metadata.trace_final_reason_code,
        usage: {
            promptTokens: metadataLike.usage?.promptTokens,
            completionTokens: metadataLike.usage?.completionTokens,
            totalTokens: metadataLike.usage?.totalTokens,
        },
        cost: {
            inputCostUsd: metadataLike.cost?.inputCostUsd,
            outputCostUsd: metadataLike.cost?.outputCostUsd,
            totalCostUsd: metadataLike.cost?.totalCostUsd,
        },
        workflow: toWorkflowSummary(metadata.workflow),
        execution: toExecutionSummary(metadata.execution),
    };
};

const toIngestionEndpoint = (baseUrl: string): string =>
    `${baseUrl.replace(/\/+$/, '')}/api/public/ingestion`;

export type LangfuseMetadataMirror = (
    metadata: ResponseMetadata
) => Promise<void>;

export const createLangfuseMetadataMirrorExporter = (
    config: RuntimeConfig['langfuseMetadataMirror']
): LangfuseMetadataMirror => {
    if (
        !config.enabled ||
        config.baseUrl === null ||
        config.publicKey === null ||
        config.secretKey === null
    ) {
        return async () => undefined;
    }

    const endpoint = toIngestionEndpoint(config.baseUrl);
    const authToken = Buffer.from(
        `${config.publicKey}:${config.secretKey}`
    ).toString('base64');

    return async (metadata: ResponseMetadata): Promise<void> => {
        const nowIso = new Date().toISOString();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

        try {
            const payload = {
                batch: [
                    {
                        id: `footnote-metadata-mirror-${metadata.responseId}-${Date.now()}`,
                        type: 'trace-create',
                        timestamp: nowIso,
                        body: {
                            id: metadata.responseId,
                            timestamp: nowIso,
                            name: 'footnote-metadata-mirror',
                            metadata: toSafeMirrorMetadata(metadata),
                        },
                    },
                ],
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Basic ${authToken}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(
                    `Langfuse metadata mirror export failed with status ${response.status}`
                );
            }
        } finally {
            clearTimeout(timeout);
        }
    };
};
