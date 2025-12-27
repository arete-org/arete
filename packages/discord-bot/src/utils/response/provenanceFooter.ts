/**
 * @description: Builds provenance footer embeds with trace metadata and actions.
 * @arete-scope: interface
 * @arete-module: ProvenanceFooter
 * @arete-risk: moderate - Footer errors can hide provenance or break user actions.
 * @arete-ethics: high - Provenance display affects transparency and accountability.
 */
import { EmbedBuilder } from './EmbedBuilder.js';
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { logger } from '../logger.js';
import type { ResponseMetadata, RiskTier, Citation } from '@arete/backend/ethics-core';

// Footer payload type: Embed plus interactive components (buttons)
type ProvenanceFooterPayload = { embeds: EmbedBuilder[], components: ActionRowBuilder<ButtonBuilder>[] };

// Module-scoped logger
const console = logger.child({ module: 'provenanceFooter' });

// UI colors for RiskTier levels
const RISK_TIER_COLORS: Record<RiskTier, string> = {
    Low: '#7FDCA4',     // Sage green
    Medium: '#F8E37C',  // Warm gold
    High: '#E27C7C',    // Soft coral
    // Used to be green/yellow/red but changed to be friendlier without losing the meaning
};

/**
 * Builds the provenance footer embed and button components for a Discord message.
 *
 * @param responseMetadata - Metadata describing the generated response and its provenance.
 * @param webBaseUrl - Base URL for linking to the full trace; defaults to https://arete.org when falsy.
 */
export function buildFooterEmbed(responseMetadata: ResponseMetadata, webBaseUrl: string): ProvenanceFooterPayload {
    const embed = new EmbedBuilder();
    const normalizedBaseUrl = webBaseUrl.trim().replace(/\/+$/, ''); // Remove trailing slashes

    // RiskTier is reflected in the embed color band
    const riskColor: string = RISK_TIER_COLORS[responseMetadata.riskTier] || '#000000';
    if (riskColor == '#000000') {
        console.warn(`Unknown RiskTier: ${responseMetadata.riskTier}, defaulting to black color.`);
    }
    embed.setColor(riskColor);

    //
    // Embed content
    //
    // Provenance
    embed.setTitle(`Reasoning - ${responseMetadata.provenance }`); // reduce vertical space, provenance in title

    // Build description string
    // Instead of using inline eelements, we build a description that ideally only takes one line
    // This keeps the footer compact and avoids wrapping on narrow screens
    const descriptionParts: string[] = [];

    // Confidence, displayed as a percentage (e.g. "85%")
    if (responseMetadata.confidence < 0.0 || responseMetadata.confidence > 1.0) {
        console.warn(`Confidence score out of bounds: ${responseMetadata.confidence} - Reporting as 0%`);
        descriptionParts.push(`0% confidence`);
    } else {
        descriptionParts.push(`${(responseMetadata.confidence * 100).toFixed(0)}% confidence`);
    }

    // Trade-offs, if any
    // We won't always have trade-offs surfaced as it depends on the context
    if (responseMetadata.tradeoffCount > 0) {
        descriptionParts.push(`${responseMetadata.tradeoffCount} trade-offs considered`);
    }

    // Citations, if any
    // Only list the hostnames with link embedded - the Sources button can be used for more detailed information
    // Discord also shows you the full URL on mouseover
    if (responseMetadata.citations.length > 0) {
        const citationLines = responseMetadata.citations.map((c: Citation) => {
            // Extract just the hostname from the URL
            const domain = c.url.hostname.replace('www.', '');
            // Return hostname embedded with url
            return `[${domain}](${c.url})`;
        }).join(' • '); // Join multiple citations with smaller dot
        descriptionParts.push(`Sources:\n${citationLines}`); // Push citations to new line for readability. Use term "Sources " instead of "Citations" for clarity
    }
    
    // At last, set the description
    embed.setDescription(descriptionParts.join(' • '));

    // Footer: model | chainHash | sessionID | license
    // I would add links to sessionID and license, but Discord footers don't support links
    // Thankfully we already have the Full Trace button, which provides a source for more detailed information
    embed.setFooter({ 
        text: `${responseMetadata.modelVersion} • ${responseMetadata.chainHash} • ${responseMetadata.responseId} • ${responseMetadata.licenseContext}`
    });

    //
    // Interactable Buttons
    //
    const actionRow = new ActionRowBuilder<ButtonBuilder>()

    // Explain button
    const explainButton = new ButtonBuilder()
        .setCustomId('explain')
        .setLabel('Explain')
        .setStyle(ButtonStyle.Primary) // Primary style for emphasis
        .setEmoji('\u{1F9E0}'); // Brain
    actionRow.addComponents(explainButton);

    // Alternative Lens button
    const altLensButton = new ButtonBuilder()
        .setCustomId('alternative_lens')
        .setLabel('Alternative Lens')
        .setStyle(ButtonStyle.Secondary) // Secondary style
        .setEmoji('\u{1F50D}'); // Magnifying glass
    actionRow.addComponents(altLensButton);

    // Full Trace button
    const fullTraceButton = new ButtonBuilder()
        .setLabel('Full Trace')
        .setStyle(ButtonStyle.Link) // Link style for external URL
        .setEmoji('\u{1F4DC}') // Scroll
        .setURL(`${normalizedBaseUrl}/trace/${responseMetadata.responseId}`);
    actionRow.addComponents(fullTraceButton);

    // Report Issue button
    const reportIssueButton = new ButtonBuilder()
        .setCustomId('report_issue')
        .setLabel('Report Issue')
        .setStyle(ButtonStyle.Danger) // Danger style for emphasis
        .setEmoji('\u{1F6A7}'); // Construction sign
    actionRow.addComponents(reportIssueButton);

    // Return the ProvenanceFooterPayload - Embed plus interactive components (buttons)
    return { embeds: [embed], components: [actionRow] };
};


