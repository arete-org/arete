/**
 * @description: Internal runtime boundary package for Footnote generation work.
 * Defines the replaceable generation seam that backend orchestration can depend
 * on without exposing framework-specific types to public API surfaces.
 * @footnote-scope: core
 * @footnote-module: AgentRuntimeBoundary
 * @footnote-risk: high - An incorrect runtime seam can leak framework assumptions or block later runtime migration work.
 * @footnote-ethics: high - This boundary protects Footnote-owned provenance and review semantics from being swallowed by framework-specific code.
 */

/**
 * Runtime-facing role labels for one normalized generation transcript.
 */
export type RuntimeMessageRole = 'system' | 'user' | 'assistant';

/**
 * Shared reasoning effort levels that runtime adapters may support.
 */
export type GenerationReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Shared verbosity levels that runtime adapters may support.
 */
export type GenerationVerbosity = 'low' | 'medium' | 'high';

/**
 * Coarse retrieval breadth hints used across runtime adapters.
 */
export type GenerationSearchContextSize = 'low' | 'medium' | 'high';

/**
 * Search intent labels used by backend planning and runtime adapters.
 */
export type GenerationSearchIntent = 'repo_explainer' | 'current_facts';

/**
 * Normalized provenance labels that runtime adapters can surface.
 */
export type GenerationProvenance = 'Retrieved' | 'Inferred' | 'Speculative';

/**
 * One normalized message supplied to a generation runtime.
 *
 * The runtime boundary stays text-only for now because backend Reflect is the
 * first consumer, but the naming is general enough for future callers.
 */
export interface RuntimeMessage {
    /**
     * Message role in the generation transcript.
     */
    role: RuntimeMessageRole;
    /**
     * Plain text content to pass to the runtime.
     */
    content: string;
}

/**
 * Retrieval settings a runtime may use when search is enabled.
 *
 * Public API contracts still belong to backend and shared package boundaries.
 * This shape only describes what the runtime should attempt.
 */
export interface GenerationSearchRequest {
    /**
     * Concise search query chosen by backend planning logic.
     */
    query: string;
    /**
     * Coarse retrieval breadth hint supplied by backend planning logic.
     */
    contextSize: GenerationSearchContextSize;
    /**
     * Search mode requested by backend planning logic.
     */
    intent: GenerationSearchIntent;
    /**
     * Optional focus tags that can help repo- or domain-specific retrieval.
     */
    repoHints?: string[];
}

/**
 * Backend-to-runtime input for one generation attempt.
 *
 * The request only carries generation concerns. Planner state, auth,
 * rate-limiting, trace persistence, and incident/review behavior remain owned
 * by backend code outside this package.
 */
export interface GenerationRequest {
    /**
     * Normalized text conversation to hand to the runtime.
     */
    messages: RuntimeMessage[];
    /**
     * Preferred model identifier, when the caller wants to steer runtime
     * selection without coupling to one provider implementation.
     */
    model?: string;
    /**
     * Optional max token/output budget hint for the runtime.
     */
    maxOutputTokens?: number;
    /**
     * Requested reasoning effort level for the generation attempt.
     */
    reasoningEffort?: GenerationReasoningEffort;
    /**
     * Requested verbosity level for the generation attempt.
     */
    verbosity?: GenerationVerbosity;
    /**
     * Retrieval settings. Omit this field when search should stay disabled.
     */
    search?: GenerationSearchRequest;
    /**
     * Optional cancellation signal forwarded from backend orchestration.
     */
    signal?: AbortSignal;
}

/**
 * One normalized citation surfaced by a runtime adapter.
 *
 * Backend code can use these facts when deriving Footnote-owned provenance
 * metadata later, but the runtime package does not own the public metadata
 * contract itself.
 */
export interface GenerationCitation {
    /**
     * Human-readable citation label or source title.
     */
    title: string;
    /**
     * Canonical URL for the cited source.
     */
    url: string;
    /**
     * Optional source excerpt, when the runtime exposes one safely.
     */
    snippet?: string;
}

/**
 * Normalized token accounting returned by a runtime adapter.
 */
export interface GenerationUsage {
    /**
     * Input or prompt token count, when the runtime exposes it.
     */
    promptTokens?: number;
    /**
     * Output or completion token count, when the runtime exposes it.
     */
    completionTokens?: number;
    /**
     * Total token count, when the runtime exposes it.
     */
    totalTokens?: number;
}

/**
 * Retrieval facts surfaced by a runtime adapter.
 */
export interface GenerationRetrieval {
    /**
     * Whether backend asked the runtime to attempt retrieval.
     */
    requested: boolean;
    /**
     * Whether the runtime actually used retrieval during execution.
     */
    used: boolean;
}

/**
 * Runtime-to-backend result for one generation attempt.
 *
 * The result stays deliberately narrow. It returns normalized output text plus
 * the facts backend needs for metadata assembly, cost accounting, and runtime
 * diagnostics.
 */
export interface GenerationResult {
    /**
     * Final user-visible text generated by the runtime.
     */
    text: string;
    /**
     * Model identifier actually used by the runtime, when known.
     */
    model?: string;
    /**
     * Optional provider/runtime finish reason for debugging or metadata
     * assembly.
     */
    finishReason?: string;
    /**
     * Normalized token usage facts, when the runtime exposes them.
     */
    usage?: GenerationUsage;
    /**
     * Optional citations surfaced by the runtime.
     */
    citations?: GenerationCitation[];
    /**
     * Retrieval request and execution facts for this attempt.
     */
    retrieval?: GenerationRetrieval;
    /**
     * Runtime-reported provenance classification, when available.
     */
    provenance?: GenerationProvenance;
}

/**
 * Replaceable runtime implementation for text generation.
 *
 * Future adapters such as a legacy adapter or VoltAgent adapter should satisfy
 * this interface so backend code can depend on one stable seam.
 */
export interface GenerationRuntime {
    /**
     * Stable runtime identifier used for wiring and diagnostics.
     */
    readonly kind: string;
    /**
     * Run one text-only generation request.
     */
    generate(request: GenerationRequest): Promise<GenerationResult>;
}

/**
 * Minimal runtime factory options for the internal generation seam.
 *
 * This stays intentionally small so backend code can depend on one stable
 * entrypoint while runtime wiring evolves behind the package boundary.
 */
export interface CreateGenerationRuntimeOptions {
    /**
     * Requested runtime implementation key.
     */
    kind?: string;
}

/**
 * Placeholder runtime factory for the internal generation boundary.
 *
 * The current implementation only establishes the seam. Real adapter
 * construction will replace this placeholder when backend wiring is ready.
 */
export function createGenerationRuntime(
    options: CreateGenerationRuntimeOptions = {}
): GenerationRuntime {
    const kind = options.kind ?? 'unconfigured';

    return {
        kind,
        async generate(): Promise<GenerationResult> {
            throw new Error(
                `Generation runtime "${kind}" has not been implemented yet.`
            );
        },
    };
}

export {
    createLegacyOpenAiRuntime,
    type LegacyOpenAiClient,
    type LegacyOpenAiGenerateOptions,
    type LegacyOpenAiMetadata,
    type LegacyOpenAiResult,
} from './legacyOpenAiRuntime.js';
