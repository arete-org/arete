/**
 * @description: Adds a slash-only one-shot chat command for fast profile/model switching.
 * @footnote-scope: interface
 * @footnote-module: ChatCommand
 * @footnote-risk: medium - Command wiring errors can misroute requests or hide backend chat failures.
 * @footnote-ethics: medium - Exposes backend profile selection to users and should remain transparent/fail-open.
 */
import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    type SlashCommandStringOption,
} from 'discord.js';
import type { ChatProfileOption } from '@footnote/contracts/web';
import { botApi } from '../api/botApi.js';
import type { DiscordChatApiResponse } from '../api/index.js';
import { logger } from '../utils/logger.js';
import type { Command, SlashCommand } from './BaseCommand.js';

const PROFILE_CHOICE_LIMIT = 25;
const MAX_PROFILE_CHOICE_LABEL = 100;
const MAX_REPLY_LENGTH = 2000;

type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
type Verbosity = 'low' | 'medium' | 'high';

type ChatCommandWithProfiles = Command & {
    setProfileChoices: (profiles: ChatProfileOption[]) => void;
};

const clampReplyContent = (content: string): string => {
    if (content.length <= MAX_REPLY_LENGTH) {
        return content;
    }

    return `${content.slice(0, MAX_REPLY_LENGTH - 3)}...`;
};

const toChoiceName = (profile: ChatProfileOption): string => {
    const description = profile.description?.trim();
    const rawLabel =
        description && description.length > 0
            ? `${profile.id} - ${description}`
            : profile.id;
    if (rawLabel.length <= MAX_PROFILE_CHOICE_LABEL) {
        return rawLabel;
    }

    return `${rawLabel.slice(0, MAX_PROFILE_CHOICE_LABEL - 3)}...`;
};

const addProfileOption = (
    option: SlashCommandStringOption,
    profileChoices: ChatProfileOption[]
): SlashCommandStringOption => {
    const baseOption = option
        .setName('profile_id')
        .setDescription('Optional model profile id to use for this one request')
        .setRequired(false);

    if (profileChoices.length === 0) {
        return baseOption;
    }

    for (const profile of profileChoices.slice(0, PROFILE_CHOICE_LIMIT)) {
        baseOption.addChoices({
            name: toChoiceName(profile),
            value: profile.id,
        });
    }

    return baseOption;
};

const buildChatCommandData = (
    profileChoices: ChatProfileOption[]
): SlashCommand => {
    const builder = new SlashCommandBuilder()
        .setName('chat')
        .setDescription(
            'Send a one-shot prompt with optional profile/model tweaks'
        )
        .addStringOption((option) =>
            option
                .setName('prompt')
                .setDescription('Prompt to send to backend chat')
                .setRequired(true)
        )
        .addStringOption((option) => addProfileOption(option, profileChoices))
        .addStringOption((option) =>
            option
                .setName('reasoning_effort')
                .setDescription('Reasoning effort hint for this request')
                .addChoices(
                    { name: 'Minimal', value: 'minimal' },
                    { name: 'Low', value: 'low' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'High', value: 'high' }
                )
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName('verbosity')
                .setDescription('Verbosity hint for this request')
                .addChoices(
                    { name: 'Low', value: 'low' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'High', value: 'high' }
                )
                .setRequired(false)
        );

    return builder;
};

const toChatFailureMessage = (error: unknown): string =>
    error instanceof Error
        ? `Chat request failed: ${error.message}`
        : 'Chat request failed due to an unknown error.';

const renderNonMessageAction = (response: DiscordChatApiResponse): string => {
    switch (response.action) {
        case 'ignore':
            return 'No response generated for this request.';
        case 'react':
            return `Backend selected reaction mode (${response.reaction}). /chat currently returns text only.`;
        case 'image': {
            const prompt =
                typeof response.imageRequest === 'object' &&
                response.imageRequest &&
                typeof (response.imageRequest as { prompt?: unknown })
                    .prompt === 'string'
                    ? (response.imageRequest as { prompt: string }).prompt
                    : 'unavailable';
            return `Backend selected image mode. Prompt: "${prompt}"`;
        }
        default:
            return `Backend returned unsupported action "${response.action}".`;
    }
};

const chatCommand: ChatCommandWithProfiles = {
    data: buildChatCommandData([]),
    setProfileChoices(profiles: ChatProfileOption[]) {
        this.data = buildChatCommandData(profiles);
    },
    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply();

        const prompt = interaction.options.getString('prompt', true).trim();
        const profileId = interaction.options.getString('profile_id')?.trim();
        const reasoningEffort = interaction.options.getString(
            'reasoning_effort'
        ) as ReasoningEffort | null;
        const verbosity = interaction.options.getString(
            'verbosity'
        ) as Verbosity | null;

        try {
            const response = await botApi.chatViaApi({
                surface: 'discord',
                ...(profileId && profileId.length > 0 ? { profileId } : {}),
                trigger: {
                    kind: 'direct',
                    messageId: interaction.id,
                },
                latestUserInput: prompt,
                conversation: [{ role: 'user', content: prompt }],
                capabilities: {
                    canReact: true,
                    canGenerateImages: true,
                    canUseTts: true,
                },
                ...((reasoningEffort ?? verbosity) !== null
                    ? {
                          generation: {
                              ...(reasoningEffort ? { reasoningEffort } : {}),
                              ...(verbosity ? { verbosity } : {}),
                          },
                      }
                    : {}),
                surfaceContext: {
                    channelId: interaction.channelId ?? undefined,
                    guildId: interaction.guildId ?? undefined,
                    userId: interaction.user.id,
                },
            });

            if (
                response.action === 'message' &&
                typeof response.message === 'string'
            ) {
                await interaction.editReply({
                    content: clampReplyContent(response.message),
                });
                return;
            }

            await interaction.editReply({
                content: clampReplyContent(renderNonMessageAction(response)),
            });
        } catch (error) {
            logger.error('chat slash command failed', {
                error: error instanceof Error ? error.message : String(error),
                interactionId: interaction.id,
                channelId: interaction.channelId,
                guildId: interaction.guildId,
            });
            await interaction.editReply({
                content: clampReplyContent(toChatFailureMessage(error)),
            });
        }
    },
};

export default chatCommand;
