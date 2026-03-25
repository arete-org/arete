/**
 * @description: Builds user-facing status text for variation configurator screens.
 * @footnote-scope: utility
 * @footnote-module: VariationStatusMessage
 * @footnote-risk: low - Incorrect status text can confuse users about token availability.
 * @footnote-ethics: low - Messaging quality affects transparency but not policy decisions.
 */
import { runtimeConfig } from '../config.js';
import { buildTokenSummaryLine } from '../utils/imageTokens.js';

/**
 * Builds the status message shown at the top of the variation configurator.
 * We always surface remaining tokens so callers understand retry limits.
 */
export function buildVariationStatusMessage(
    userId: string,
    base?: string
): string {
    // Developers can bypass token spend during debugging, so surface that
    // clearly to avoid confusion when behavior differs from regular users.
    const isDeveloper = userId === runtimeConfig.developerUserId;
    if (isDeveloper) {
        return base
            ? `${base}\n\nDeveloper bypass active—image tokens are not required.`
            : 'Developer bypass active—image tokens are not required.';
    }

    const summary = buildTokenSummaryLine(userId);
    return base ? `${base}\n\n${summary}` : summary;
}
