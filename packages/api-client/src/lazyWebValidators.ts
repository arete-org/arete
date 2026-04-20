/**
 * @description: Lazily loads web response validators so schema runtime is fetched only when endpoints are called.
 * @footnote-scope: utility
 * @footnote-module: LazyWebValidators
 * @footnote-risk: medium - Broken lazy imports would fail endpoint-level response validation at runtime.
 * @footnote-ethics: medium - Preserves validation while reducing eager startup code in user-facing surfaces.
 */

import type {
    GetChatProfilesResponse,
    GetTraceResponse,
    GetTraceStaleResponse,
    PostChatResponse,
} from '@footnote/contracts/web';
import type { ApiResponseValidator } from '@footnote/contracts/web/client-core';

type WebSchemasModule = typeof import('@footnote/contracts/web/schemas');

let webSchemasModulePromise: Promise<WebSchemasModule> | null = null;
let getChatProfilesResponseValidatorPromise: Promise<
    ApiResponseValidator<GetChatProfilesResponse>
> | null = null;
let postChatResponseValidatorPromise: Promise<
    ApiResponseValidator<PostChatResponse>
> | null = null;
let getTraceApiResponseValidatorPromise: Promise<
    ApiResponseValidator<GetTraceResponse | GetTraceStaleResponse>
> | null = null;

const loadWebSchemasModule = async (): Promise<WebSchemasModule> => {
    if (!webSchemasModulePromise) {
        webSchemasModulePromise =
            import('@footnote/contracts/web/schemas').catch((error) => {
                webSchemasModulePromise = null;
                throw error;
            });
    }

    return webSchemasModulePromise;
};

export const loadGetChatProfilesResponseValidator = async (): Promise<
    ApiResponseValidator<GetChatProfilesResponse>
> => {
    if (!getChatProfilesResponseValidatorPromise) {
        getChatProfilesResponseValidatorPromise = loadWebSchemasModule()
            .then(
                ({
                    GetChatProfilesResponseSchema,
                    createSchemaResponseValidator,
                }) =>
                    createSchemaResponseValidator(GetChatProfilesResponseSchema)
            )
            .catch((error) => {
                getChatProfilesResponseValidatorPromise = null;
                throw error;
            });
    }

    return getChatProfilesResponseValidatorPromise;
};

export const loadPostChatResponseValidator = async (): Promise<
    ApiResponseValidator<PostChatResponse>
> => {
    if (!postChatResponseValidatorPromise) {
        postChatResponseValidatorPromise = loadWebSchemasModule()
            .then(({ PostChatResponseSchema, createSchemaResponseValidator }) =>
                createSchemaResponseValidator(PostChatResponseSchema)
            )
            .catch((error) => {
                postChatResponseValidatorPromise = null;
                throw error;
            });
    }

    return postChatResponseValidatorPromise;
};

export const loadGetTraceApiResponseValidator = async (): Promise<
    ApiResponseValidator<GetTraceResponse | GetTraceStaleResponse>
> => {
    if (!getTraceApiResponseValidatorPromise) {
        getTraceApiResponseValidatorPromise = loadWebSchemasModule()
            .then(
                ({
                    GetTraceApiResponseSchema,
                    createSchemaResponseValidator,
                }) => createSchemaResponseValidator(GetTraceApiResponseSchema)
            )
            .catch((error) => {
                getTraceApiResponseValidatorPromise = null;
                throw error;
            });
    }

    return getTraceApiResponseValidatorPromise;
};
