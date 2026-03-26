/**
 * @description: Thin compatibility wrapper around the shared internal image API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordInternalImageApi
 * @footnote-risk: medium - Transport mistakes can break backend-owned image tasks.
 * @footnote-ethics: medium - Narrow task transport helps keep backend-owned image policy explicit.
 */
import {
    createInternalImageApi as createSharedInternalImageApi,
    type CreateInternalImageApiOptions,
    type InternalImageApi,
} from '@footnote/api-client';
import type { ApiRequester, CreateApiTransportOptions } from './client.js';

export type { CreateInternalImageApiOptions, InternalImageApi };

export const createInternalImageApi = (
    requestJson: ApiRequester,
    options: CreateInternalImageApiOptions & CreateApiTransportOptions
): InternalImageApi => {
    const shared = createSharedInternalImageApi(requestJson, options);

    const runImageTaskViaApi: InternalImageApi['runImageTaskViaApi'] = (
        request,
        runOptions
    ) => shared.runImageTaskViaApi(request, runOptions);
    const runImageTaskStreamViaApi: InternalImageApi['runImageTaskStreamViaApi'] =
        (request, runOptions) =>
            shared.runImageTaskStreamViaApi(request, runOptions);

    return {
        runImageTaskViaApi,
        runImageTaskStreamViaApi,
    };
};
