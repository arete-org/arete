/**
 * @description: Resolves user follow-up replies against prior weather clarification lists.
 * Converts plain-text clarification options back into deterministic weather tool inputs.
 * @footnote-scope: utility
 * @footnote-module: WeatherClarificationContinuation
 * @footnote-risk: medium - Incorrect matching can select the wrong place and fetch the wrong forecast.
 * @footnote-ethics: medium - Follow-up resolution affects user trust, so ambiguous matches fail open to re-ask.
 */
import type { PostChatRequest } from '@footnote/contracts/web';
import type { WeatherForecastRequest } from '../contextIntegrations/weather/index.js';

type ParsedClarificationOption = {
    id: string;
    label: string;
    input: WeatherForecastRequest;
};

export type PendingWeatherClarification = {
    question: string;
    options: ParsedClarificationOption[];
};

type ClarificationResolution =
    | {
          kind: 'resolved';
          selectedOption: ParsedClarificationOption;
          pending: PendingWeatherClarification;
      }
    | {
          kind: 'unresolved';
          pending: PendingWeatherClarification;
      }
    | {
          kind: 'none';
      };

const ORDINAL_MAP: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
};

const US_STATE_ALIASES: Record<string, string[]> = {
    AL: ['alabama'],
    AK: ['alaska'],
    AZ: ['arizona'],
    AR: ['arkansas'],
    CA: ['california'],
    CO: ['colorado'],
    CT: ['connecticut'],
    DE: ['delaware'],
    FL: ['florida'],
    GA: ['georgia'],
    HI: ['hawaii'],
    ID: ['idaho'],
    IL: ['illinois'],
    IN: ['indiana'],
    IA: ['iowa'],
    KS: ['kansas'],
    KY: ['kentucky'],
    LA: ['louisiana'],
    ME: ['maine'],
    MD: ['maryland'],
    MA: ['massachusetts'],
    MI: ['michigan'],
    MN: ['minnesota'],
    MS: ['mississippi'],
    MO: ['missouri'],
    MT: ['montana'],
    NE: ['nebraska'],
    NV: ['nevada'],
    NH: ['new hampshire'],
    NJ: ['new jersey'],
    NM: ['new mexico'],
    NY: ['new york'],
    NC: ['north carolina'],
    ND: ['north dakota'],
    OH: ['ohio'],
    OK: ['oklahoma'],
    OR: ['oregon'],
    PA: ['pennsylvania'],
    RI: ['rhode island'],
    SC: ['south carolina'],
    SD: ['south dakota'],
    TN: ['tennessee'],
    TX: ['texas'],
    UT: ['utah'],
    VT: ['vermont'],
    VA: ['virginia'],
    WA: ['washington'],
    WV: ['west virginia'],
    WI: ['wisconsin'],
    WY: ['wyoming'],
    DC: ['district of columbia', 'washington dc'],
};

const normalizeText = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const tryParseNumberSelection = (value: string): number | undefined => {
    const numberMatch = value.match(/\b([1-9][0-9]?)\b/);
    if (numberMatch && numberMatch[1]) {
        return Number(numberMatch[1]);
    }

    for (const [ordinal, index] of Object.entries(ORDINAL_MAP)) {
        if (value.includes(ordinal)) {
            return index;
        }
    }

    return undefined;
};

const inferCountryCode = (labelParts: string[]): string | undefined => {
    const tail = labelParts.at(-1)?.trim().toUpperCase();
    if (!tail || !/^[A-Z]{2}$/.test(tail)) {
        return undefined;
    }
    return tail;
};

const toWeatherInputFromLabel = (label: string): WeatherForecastRequest => {
    const parts = label
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    const countryCode = inferCountryCode(parts);
    const coreParts =
        countryCode !== undefined ? parts.slice(0, parts.length - 1) : parts;
    const query = coreParts.length > 0 ? coreParts.join(', ') : label.trim();
    return {
        location: {
            type: 'place_query',
            query,
            ...(countryCode !== undefined && { countryCode }),
        },
    };
};

const parseClarificationFromAssistantMessage = (
    content: string
): PendingWeatherClarification | null => {
    if (!content.includes('Please reply with your choice.')) {
        return null;
    }

    const options: ParsedClarificationOption[] = [];
    const optionPattern = /^\s*(\d+)\.\s+(.+?)\s*$/gm;
    let match: RegExpExecArray | null = optionPattern.exec(content);
    while (match) {
        const indexText = match[1];
        const label = match[2]?.trim();
        if (indexText && label) {
            options.push({
                id: `option-${indexText}`,
                label,
                input: toWeatherInputFromLabel(label),
            });
        }
        match = optionPattern.exec(content);
    }

    if (options.length === 0) {
        return null;
    }

    return {
        question: 'Which location did you mean?',
        options,
    };
};

const findPendingWeatherClarification = (
    conversation: PostChatRequest['conversation']
): PendingWeatherClarification | null => {
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
        const message = conversation[index];
        if (!message || message.role !== 'assistant') {
            continue;
        }

        const parsed = parseClarificationFromAssistantMessage(message.content);
        if (parsed) {
            return parsed;
        }
    }

    return null;
};

const normalizeStateTokens = (userText: string): Set<string> => {
    const normalized = normalizeText(userText);
    const tokens = new Set<string>();
    for (const [abbr, names] of Object.entries(US_STATE_ALIASES)) {
        if (normalized.includes(abbr.toLowerCase())) {
            tokens.add(abbr.toLowerCase());
        }
        if (names.some((name) => normalized.includes(name))) {
            tokens.add(abbr.toLowerCase());
        }
    }
    return tokens;
};

const matchOptionByText = (
    userText: string,
    options: ParsedClarificationOption[]
): ParsedClarificationOption | null => {
    const normalizedUserText = normalizeText(userText);
    if (normalizedUserText.length === 0) {
        return null;
    }

    const directMatches = options.filter((option) =>
        normalizeText(option.label).includes(normalizedUserText)
    );
    if (directMatches.length === 1) {
        return directMatches[0] ?? null;
    }

    const stateTokens = normalizeStateTokens(userText);
    if (stateTokens.size > 0) {
        const stateMatches = options.filter((option) => {
            const normalizedLabel = normalizeText(option.label);
            for (const token of stateTokens) {
                const aliases = US_STATE_ALIASES[token.toUpperCase()] ?? [];
                if (
                    normalizedLabel.includes(token) ||
                    aliases.some((alias) =>
                        normalizedLabel.includes(normalizeText(alias))
                    )
                ) {
                    return true;
                }
            }
            return false;
        });
        if (stateMatches.length === 1) {
            return stateMatches[0] ?? null;
        }
    }

    return null;
};

export const resolveWeatherClarificationContinuation = (
    request: PostChatRequest
): ClarificationResolution => {
    const pending = findPendingWeatherClarification(request.conversation);
    if (!pending) {
        return { kind: 'none' };
    }

    const normalizedInput = normalizeText(request.latestUserInput);
    const numericChoice = tryParseNumberSelection(normalizedInput);
    if (
        numericChoice !== undefined &&
        numericChoice >= 1 &&
        numericChoice <= pending.options.length
    ) {
        const selectedOption = pending.options[numericChoice - 1];
        if (selectedOption) {
            return {
                kind: 'resolved',
                selectedOption,
                pending,
            };
        }
    }

    const textMatch = matchOptionByText(
        request.latestUserInput,
        pending.options
    );
    if (textMatch) {
        return {
            kind: 'resolved',
            selectedOption: textMatch,
            pending,
        };
    }

    return {
        kind: 'unresolved',
        pending,
    };
};
