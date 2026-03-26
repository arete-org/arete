/**
 * @description: Thin compatibility wrapper around the shared incident API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordIncidentApi
 * @footnote-risk: medium - Incident API failures can block report submission and review tooling.
 * @footnote-ethics: high - Stable incident transport is required for durable reporting and privacy-safe review.
 */
import {
    createIncidentApi as createSharedIncidentApi,
    type CreateIncidentApiOptions,
    type IncidentApi,
} from '@footnote/api-client';
import type { ApiRequester } from './client.js';

export type { CreateIncidentApiOptions, IncidentApi };

export const createIncidentApi = (
    requestJson: ApiRequester,
    { traceApiToken }: CreateIncidentApiOptions = {}
): IncidentApi =>
    createSharedIncidentApi(requestJson, {
        traceApiToken,
    });
