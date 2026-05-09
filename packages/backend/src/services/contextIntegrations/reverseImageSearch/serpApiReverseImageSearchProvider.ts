/**
 * @description: SerpAPI-backed reverse image search provider for chat context integration.
 * Converts Google Lens-style response payloads into bounded advisory matches for provenance context.
 * @footnote-scope: core
 * @footnote-module: SerpApiReverseImageSearchProvider
 * @footnote-risk: medium - Incorrect provider parsing can hide useful sources or surface malformed citations.
 * @footnote-ethics: medium - Reverse-image matches can influence user trust, so output stays bounded and fail-open.
 */
import type {
    ReverseImageSearchProvider,
    ReverseImageSearchProviderResponse,
} from './reverseImageSearchContextStepExecutor.js';

type ReverseImageSearchLogger = {
    warn: (message: string, meta?: Record<string, unknown>) => void;
};

type CreateSerpApiReverseImageSearchProviderOptions = {
    apiKey: string;
    requestTimeoutMs: number;
    logger: ReverseImageSearchLogger;
    fetchImpl?: typeof fetch;
};

type SerpApiVisualMatch = {
    title?: unknown;
    link?: unknown;
    snippet?: unknown;
    confidence?: unknown;
};

type SerpApiKnowledgeGraph = {
    title?: unknown;
    source?: {
        name?: unknown;
    };
};

type SerpApiResponse = {
    visual_matches?: unknown;
    knowledge_graph?: unknown;
};

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;

const toVisualMatches = (value: unknown): SerpApiVisualMatch[] =>
    Array.isArray(value)
        ? value.filter(
              (entry): entry is SerpApiVisualMatch =>
                  typeof entry === 'object' && entry !== null
          )
        : [];

const sanitizeUrlForLogs = (value: string): string => {
    try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return '[invalid_url]';
    }
};

const parseConfidence = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value >= 0 && value <= 1) {
            return value;
        }
        if (value > 1 && value <= 100) {
            return value / 100;
        }
        return undefined;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim().replace(/%$/, '');
    if (normalized.length === 0) {
        return undefined;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    if (parsed >= 0 && parsed <= 1) {
        return parsed;
    }
    if (parsed > 1 && parsed <= 100) {
        return parsed / 100;
    }
    return undefined;
};

/**
 * Builds a reverse-image provider that calls SerpAPI Google Lens endpoint.
 *
 * Fail-open contract:
 * - Throws only for transport/provider errors.
 * - Returns empty matches for parseable but non-match payloads.
 */
export const createSerpApiReverseImageSearchProvider = ({
    apiKey,
    requestTimeoutMs,
    logger,
    fetchImpl = fetch,
}: CreateSerpApiReverseImageSearchProviderOptions): ReverseImageSearchProvider => {
    return {
        search: async ({
            imageUrl,
            context,
        }): Promise<ReverseImageSearchProviderResponse> => {
            const endpoint = new URL('https://serpapi.com/search.json');
            endpoint.searchParams.set('engine', 'google_lens');
            endpoint.searchParams.set('url', imageUrl);
            endpoint.searchParams.set('api_key', apiKey);

            const signal = AbortSignal.timeout(requestTimeoutMs);
            const response = await fetchImpl(endpoint.toString(), {
                method: 'GET',
                signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `SerpAPI reverse image search failed with HTTP ${response.status} (response body omitted; length=${body.length}).`
                );
            }

            const raw = (await response.json()) as SerpApiResponse;
            const visualMatches = toVisualMatches(raw.visual_matches);
            const matches = visualMatches
                .map((match) => {
                    const title = asString(match.title);
                    const url = asString(match.link);
                    if (!title || !url) {
                        return null;
                    }
                    const confidence = parseConfidence(match.confidence);
                    return {
                        title,
                        url,
                        ...(asString(match.snippet) !== undefined && {
                            snippet: asString(match.snippet),
                        }),
                        ...(confidence !== undefined && { confidence }),
                    };
                })
                .filter(
                    (match): match is NonNullable<typeof match> =>
                        match !== null
                );

            const knowledgeGraph =
                typeof raw.knowledge_graph === 'object' &&
                raw.knowledge_graph !== null
                    ? (raw.knowledge_graph as SerpApiKnowledgeGraph)
                    : undefined;
            const graphTitle = asString(knowledgeGraph?.title);
            const sourceName = asString(knowledgeGraph?.source?.name);
            const summary =
                matches.length > 0
                    ? `Reverse image search found ${matches.length} related public match${matches.length === 1 ? '' : 'es'}.`
                    : graphTitle
                      ? `Reverse image search found no direct visual matches, but detected likely subject: ${graphTitle}${sourceName ? ` (${sourceName})` : ''}.`
                      : 'Reverse image search returned no matches for this image.';

            if (matches.length === 0 && graphTitle === undefined) {
                logger.warn(
                    'reverse_image_search: SerpAPI returned no visual matches.',
                    {
                        imageUrl: sanitizeUrlForLogs(imageUrl),
                        hasContext: Boolean(context),
                    }
                );
            }

            return {
                providerId: 'serpapi_google_lens',
                summary,
                matches,
            };
        },
    };
};
