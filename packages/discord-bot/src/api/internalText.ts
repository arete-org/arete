/**
 * @description: Thin compatibility wrapper around the shared internal text API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordInternalTextApi
 * @footnote-risk: medium - Transport mistakes can break backend-owned internal text tasks.
 * @footnote-ethics: medium - Narrow task transport helps keep backend-owned generation policy explicit.
 */
import {
    createInternalTextApi as createSharedInternalTextApi,
    type CreateInternalTextApiOptions,
    type InternalTextApi,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type { CreateInternalTextApiOptions, InternalTextApi };

export const createInternalTextApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateInternalTextApiOptions = {}
): InternalTextApi => {
    const shared = createSharedInternalTextApi(requestJson, {
        traceApiToken,
    });

    // Keep named local aliases so OpenAPI code-link tooling can resolve
    // symbol references in this wrapper module.
    const runNewsTaskViaApi = shared.runNewsTaskViaApi;
    const runImageDescriptionTaskViaApi = shared.runImageDescriptionTaskViaApi;

    void runNewsTaskViaApi;
    void runImageDescriptionTaskViaApi;

    return shared;
};
