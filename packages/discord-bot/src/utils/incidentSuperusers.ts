/**
 * @description: Small helper for incident-review authorization in Discord command handlers.
 * @footnote-scope: utility
 * @footnote-module: IncidentSuperusers
 * @footnote-risk: medium - Incorrect checks can expose incident review actions to the wrong users.
 * @footnote-ethics: high - Incident review access controls protect sensitive report data.
 */
import { runtimeConfig } from '../config.js';

/**
 * Returns whether the given Discord user ID may access the private incident
 * review commands.
 */
export const isIncidentSuperuser = (userId: string): boolean =>
    runtimeConfig.incidentReview.superuserIds.includes(userId);
