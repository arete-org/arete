/**
 * @description: Thin compatibility wrapper around the shared internal voice API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordInternalVoiceApi
 * @footnote-risk: medium - Transport mistakes can break backend-owned voice TTS tasks.
 * @footnote-ethics: high - Voice synthesis requests carry user text and must stay within trusted boundaries.
 */
import {
    createInternalVoiceApi as createSharedInternalVoiceApi,
    type CreateInternalVoiceApiOptions,
    type InternalVoiceApi,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type { CreateInternalVoiceApiOptions, InternalVoiceApi };

export const createInternalVoiceApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateInternalVoiceApiOptions = {}
): InternalVoiceApi => {
    const shared = createSharedInternalVoiceApi(requestJson, { traceApiToken });

    const runVoiceTtsViaApi: InternalVoiceApi['runVoiceTtsViaApi'] = (
        request,
        options
    ) => shared.runVoiceTtsViaApi(request, options);

    return {
        runVoiceTtsViaApi,
    };
};
