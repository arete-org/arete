/**
 * @description: Handles incident-report consent and cancel buttons.
 * @footnote-scope: core
 * @footnote-module: IncidentButtonHandlers
 * @footnote-risk: medium - Incorrect routing can block incident follow-up controls.
 * @footnote-ethics: high - Incident reporting controls are part of user-facing safety and accountability workflows.
 */
import type { ButtonInteraction } from 'discord.js';
import {
    handleIncidentReportCancel,
    handleIncidentReportConsent,
    INCIDENT_REPORT_CANCEL_PREFIX,
    INCIDENT_REPORT_CONSENT_PREFIX,
} from '../../utils/response/incidentReporting.js';

/**
 * Routes incident-specific button actions that are not provenance CGI actions.
 */
export async function handleIncidentButtonInteraction(
    interaction: ButtonInteraction
): Promise<boolean> {
    const { customId } = interaction;

    if (customId.startsWith(INCIDENT_REPORT_CANCEL_PREFIX)) {
        await handleIncidentReportCancel(interaction);
        return true;
    }

    if (customId.startsWith(INCIDENT_REPORT_CONSENT_PREFIX)) {
        await handleIncidentReportConsent(interaction);
        return true;
    }

    return false;
}
