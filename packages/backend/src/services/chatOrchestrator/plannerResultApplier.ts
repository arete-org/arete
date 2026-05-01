/**
 * @description: Applies planner output under backend policy and prepares
 * downstream workflow inputs without granting planner authority.
 * @footnote-scope: core
 * @footnote-module: ChatOrchestratorPlannerResultApplier
 * @footnote-risk: high - Incorrect policy application can route execution to wrong profiles/tools.
 * @footnote-ethics: high - Keeps planner suggestions advisory and backend policy authoritative.
 */
import type { ModelProfile } from '@footnote/contracts';
import type { PostChatRequest } from '@footnote/contracts/web';
import type { ChatPlan } from '../chatPlanner.js';
import type { ChatGenerationPlan } from '../chatGenerationTypes.js';
import { coercePlanForSurface } from '../chatSurfacePolicy.js';
import { applySingleToolPolicy } from '../tools/toolPolicy.js';
import { resolveToolSelection } from '../tools/toolRegistry.js';
import type { WeatherForecastTool } from '../openMeteoForecastTool.js';
import { resolveExecutionProfile } from './profileResolution.js';
import type {
    PlannerApplicationInput,
    PlannerApplicationResult,
} from '../plannerWorkflowSeams.js';

type PlannerSelectionSource = 'default' | 'planner' | 'request_override';

export type CreatePlannerResultApplierInput = {
    enabledProfiles: ModelProfile[];
    searchCapableProfiles: ModelProfile[];
    enabledProfilesById: Map<string, ModelProfile>;
    defaultResponseProfile: ModelProfile;
    weatherForecastTool?: WeatherForecastTool;
    logger: {
        debug: (message: string, meta?: Record<string, unknown>) => void;
        warn: (message: string, meta?: Record<string, unknown>) => void;
    };
};

export type PlannerResultApplierBootstrap = {
    normalizedRequest: PostChatRequest;
    clarificationContinuation:
        | {
              kind: 'resolved';
              selectedOption: { input: Record<string, unknown> };
          }
        | { kind: 'none' | 'unresolved' };
    resolvedExecutionPolicy: Parameters<
        typeof resolveExecutionProfile
    >[0]['resolvedExecutionPolicy'];
};

export const createPlannerResultApplier = (
    input: CreatePlannerResultApplierInput
): ((
    plannerInput: PlannerApplicationInput & PlannerResultApplierBootstrap
) => PlannerApplicationResult) => {
    return (plannerInput) => {
        const plannerPlan = plannerInput.plannerStepResult.plan;
        const fallbackReasons: string[] = [];
        if (plannerInput.plannerStepResult.execution.status === 'failed') {
            const plannerFailureReason =
                plannerInput.plannerStepResult.execution.reasonCode ===
                'planner_invalid_output'
                    ? 'planner_execution_failed_planner_invalid_output'
                    : plannerInput.plannerStepResult.execution.reasonCode ===
                        'planner_runtime_error'
                      ? 'planner_execution_failed_planner_runtime_error'
                      : 'planner_execution_failed_unknown';
            fallbackReasons.push(plannerFailureReason);
        }
        const { plan, surfacePolicy } = coercePlanForSurface(
            plannerInput.normalizedRequest,
            plannerPlan,
            input.logger
        );
        const requestGeneration = plannerInput.normalizedRequest.generation;
        let generationForExecution: ChatGenerationPlan = {
            ...plan.generation,
            ...(requestGeneration?.reasoningEffort
                ? { reasoningEffort: requestGeneration.reasoningEffort }
                : {}),
            ...(requestGeneration?.verbosity
                ? { verbosity: requestGeneration.verbosity }
                : {}),
        };
        if (plannerInput.clarificationContinuation.kind === 'resolved') {
            generationForExecution = {
                ...generationForExecution,
                toolIntent: {
                    toolName: 'weather_forecast',
                    requested: true,
                    input: plannerInput.clarificationContinuation.selectedOption
                        .input,
                },
            };
        }
        const toolPolicyDecision = applySingleToolPolicy(
            generationForExecution
        );
        generationForExecution = toolPolicyDecision.generation;
        if (toolPolicyDecision.logEvent) {
            input.logger.warn(
                'planner requested both weather and search; applying single-tool policy with weather priority',
                {
                    ...toolPolicyDecision.logEvent,
                    surface: plannerInput.normalizedRequest.surface,
                }
            );
        }
        const profileResolution = resolveExecutionProfile(
            {
                normalizedRequest: plannerInput.normalizedRequest,
                plan,
                enabledProfiles: input.enabledProfiles,
                searchCapableProfiles: input.searchCapableProfiles,
                enabledProfilesById: input.enabledProfilesById,
                defaultResponseProfile: input.defaultResponseProfile,
                generationForExecution,
                resolvedExecutionPolicy: plannerInput.resolvedExecutionPolicy,
            },
            input.logger
        );
        generationForExecution = profileResolution.generationForExecution;
        fallbackReasons.push(...profileResolution.fallbackReasons);
        const selectedResponseProfile =
            profileResolution.selectedResponseProfile;
        const toolSelection = resolveToolSelection({
            generation: generationForExecution,
            weatherForecastTool: input.weatherForecastTool,
            webSearchToolRequestOverride:
                profileResolution.webSearchToolRequestContextOverride,
            inheritedToolExecution: profileResolution.toolExecutionContext,
        });

        const contextStepRequest =
            toolSelection.toolRequest.toolName === 'weather_forecast' &&
            toolSelection.toolRequest.requested
                ? {
                      integrationName: 'weather_forecast',
                      requested: toolSelection.toolRequest.requested,
                      eligible: toolSelection.toolRequest.eligible,
                      ...(toolSelection.toolRequest.reasonCode !==
                          undefined && {
                          reasonCode: toolSelection.toolRequest.reasonCode,
                      }),
                      ...(toolSelection.toolIntent.input !== undefined && {
                          input: toolSelection.toolIntent.input as Record<
                              string,
                              unknown
                          >,
                      }),
                  }
                : undefined;
        const plannerApplyOutcome =
            plannerInput.plannerStepResult.execution.status !== 'executed'
                ? 'not_applied'
                : fallbackReasons.length > 0
                  ? 'adjusted_by_policy'
                  : 'applied';
        const plannerMattered = plannerApplyOutcome !== 'not_applied';
        const plannerMatteredControlIds: PlannerApplicationResult['plannerMatteredControlIds'] =
            plannerApplyOutcome === 'adjusted_by_policy'
                ? ['provider_preference']
                : [];

        return {
            plan: {
                ...plan,
                generation: generationForExecution,
                profileId: selectedResponseProfile.id,
                provider: selectedResponseProfile.provider,
                capabilities: selectedResponseProfile.capabilities,
            } as ChatPlan,
            ...(surfacePolicy !== undefined && { surfacePolicy }),
            generationForExecution,
            selectedResponseProfile,
            originalSelectedProfileId:
                profileResolution.originalSelectedProfileId,
            effectiveSelectedProfileId:
                profileResolution.effectiveSelectedProfileId,
            rerouteApplied: profileResolution.rerouteApplied,
            ...(profileResolution.selectedCapabilityProfile !== undefined && {
                selectedCapabilityProfile:
                    profileResolution.selectedCapabilityProfile,
            }),
            ...(profileResolution.capabilityReasonCode !== undefined && {
                capabilityReasonCode: profileResolution.capabilityReasonCode,
            }),
            toolRequestContext: toolSelection.toolRequest,
            toolExecutionContext: toolSelection.toolExecution,
            contextStepRequest,
            plannerApplyOutcome,
            plannerMattered,
            plannerMatteredControlIds,
            fallbackReasons,
            fallbackRollupSelectionSource:
                profileResolution.fallbackRollupSelectionSource as PlannerSelectionSource,
        };
    };
};

export type PlannerResultApplierBootstrapContext =
    PlannerResultApplierBootstrap;
