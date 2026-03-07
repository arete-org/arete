/**
 * @description: Resolves profile-scoped plaintext mention aliases and matches them against Discord message content.
 * @footnote-scope: utility
 * @footnote-module: MentionAliases
 * @footnote-risk: medium - Incorrect alias matching can make the bot miss valid engagement or trigger on unrelated text.
 * @footnote-ethics: medium - Mention matching affects when the bot joins conversations and must avoid noisy false positives.
 */

import type { BotProfileConfig } from '../config/profile.js';

const DEFAULT_FOOTNOTE_ALIAS = 'footnote';
const MAX_PLAINTEXT_ALIAS_LENGTH = 100;
const DEFAULT_FOOTNOTE_PROFILE_ID = 'footnote';

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeMentionAlias = (value: string): string | null => {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (
        normalized.length === 0 ||
        normalized.length > MAX_PLAINTEXT_ALIAS_LENGTH
    ) {
        return null;
    }

    return normalized;
};

// buildPlaintextAliasRegex is safe on user-controlled aliases because
// escapeRegExp neutralizes regex metacharacters, normalizeMentionAlias collapses
// whitespace before aliases reach this point, and MAX_PLAINTEXT_ALIAS_LENGTH
// caps the input size to keep the generated pattern bounded.
const buildPlaintextAliasRegex = (alias: string): RegExp => {
    const escapedAlias = escapeRegExp(alias).replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9])(?:${escapedAlias})(?=$|[^a-z0-9])`, 'i');
};

/**
 * Resolves the set of plaintext aliases that should count as addressing the
 * current bot runtime.
 */
export const resolveBotMentionAliases = (
    profile: BotProfileConfig,
    botUsername?: string
): string[] => {
    const candidates =
        profile.mentionAliases.length > 0
            ? [...profile.mentionAliases]
            : profile.id === DEFAULT_FOOTNOTE_PROFILE_ID
              ? [DEFAULT_FOOTNOTE_ALIAS, profile.displayName]
              : [profile.displayName];

    if (botUsername) {
        candidates.push(botUsername);
    }

    const aliases: string[] = [];
    for (const candidate of candidates) {
        const alias = normalizeMentionAlias(candidate);
        if (!alias || aliases.includes(alias)) {
            continue;
        }

        aliases.push(alias);
    }

    return aliases;
};

/**
 * Returns true when any resolved plaintext alias appears as a whole word or
 * phrase within the supplied content.
 */
export const containsPlaintextBotAlias = (
    content: string,
    aliases: readonly string[]
): boolean => {
    if (!content.trim()) {
        return false;
    }

    return aliases.some((alias) => {
        const normalizedAlias = normalizeMentionAlias(alias);
        return normalizedAlias
            ? buildPlaintextAliasRegex(normalizedAlias).test(content)
            : false;
    });
};
