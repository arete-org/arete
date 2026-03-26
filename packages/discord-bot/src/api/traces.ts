/**
 * @description: Thin compatibility wrapper around the shared trace API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordTraceApi
 * @footnote-risk: medium - Trace API failures reduce provenance reliability and debugging context.
 * @footnote-ethics: medium - Missing provenance data can weaken transparency and auditability.
 */
import {
    createTraceApi as createSharedTraceApi,
    type CreateTraceApiOptions,
    type TraceApi,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type { CreateTraceApiOptions, TraceApi };

export const createTraceApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateTraceApiOptions = {}
): TraceApi => {
    const shared = createSharedTraceApi(requestJson, { traceApiToken });

    const postTraces: TraceApi['postTraces'] = (request, options) =>
        shared.postTraces(request, options);
    const getTrace: TraceApi['getTrace'] = (responseId, options) =>
        shared.getTrace(responseId, options);
    const postTraceCard: TraceApi['postTraceCard'] = (request, options) =>
        shared.postTraceCard(request, options);
    const postTraceCardFromTrace: TraceApi['postTraceCardFromTrace'] = (
        request,
        options
    ) => shared.postTraceCardFromTrace(request, options);

    return {
        postTraces,
        getTrace,
        postTraceCard,
        postTraceCardFromTrace,
    };
};
