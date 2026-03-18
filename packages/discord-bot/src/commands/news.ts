/**
 * @description: Fetches and processes news data from external sources.
 * @footnote-scope: interface
 * @footnote-module: NewsCommand
 * @footnote-risk: medium - Handles current-facts retrieval and summarization. Failures can return stale data or break the command.
 * @footnote-ethics: medium - Presents curated news content to users, affecting information access and source framing.
 */

import { SlashCommandBuilder } from 'discord.js';
import { ChatInputCommandInteraction } from 'discord.js';
import { Command } from './BaseCommand.js';
import { botApi } from '../api/botApi.js';
import { EmbedBuilder } from '../utils/response/EmbedBuilder.js';
import { logger } from '../utils/logger.js';

const DEFAULT_MAX_RESULTS = 3;
const MAX_RESULTS = 5;

type NewsItem = {
    title: string;
    summary: string;
    url: string;
    source: string;
    timestamp: string;
    thumbnail?: string | null;
    image?: string | null;
};

type NewsResponse = {
    news: NewsItem[];
    summary?: string;
};

/**
 * Slash-command definition for fetching and summarizing current news results.
 */
const newsCommand: Command = {
    data: new SlashCommandBuilder()
        .setName('news')
        .setDescription('Get the latest news')
        .addStringOption((option) =>
            option
                .setName('query')
                .setDescription('Search query (e.g. "AI", "climate change")')
                .setRequired(false)
        )
        .addStringOption((option) =>
            option
                .setName('category')
                .setDescription('News category (e.g., tech, sports, politics)')
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option
                .setName('max_results')
                .setDescription('Maximum number of news items to return')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(MAX_RESULTS)
        )
        .addStringOption((option) =>
            option
                .setName('reasoning_effort')
                .setDescription('How much effort to put into reasoning')
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
                .setDescription('How verbose the response should be')
                .addChoices(
                    { name: 'Low', value: 'low' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'High', value: 'high' }
                )
                .setRequired(false)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        // Log command execution with timestamp and interaction ID
        logger.info(
            `[${new Date().toISOString()}] Executing /news command - Interaction ID: ${interaction.id}`
        );
        logger.info(`Interaction details:`, {
            id: interaction.id,
            commandName: interaction.commandName,
            user: interaction.user.tag,
            channel: interaction.channel?.id,
            guild: interaction.guild?.id,
            token: interaction.token ? 'PRESENT' : 'MISSING',
            isCommand: interaction.isChatInputCommand(),
            options: interaction.options.data.map((opt) => ({
                name: opt.name,
                value: opt.value,
            })),
        });

        // Immediately acknowledge the interaction
        let isDeferred = false;
        try {
            logger.info(
                `About to call deferReply() for interaction ${interaction.id}`
            );
            await interaction.deferReply();
            isDeferred = true;
            logger.info(`Successfully deferred interaction ${interaction.id}`);
        } catch (deferError) {
            logger.error(
                `Failed to defer interaction ${interaction.id}: ${deferError}`
            );
            // If defer fails, try to reply directly
            try {
                await interaction.reply({
                    content:
                        'An error occurred while processing your request. Please try again later.',
                    flags: [1 << 6], // EPHEMERAL
                });
                logger.info(
                    `Successfully replied directly to interaction ${interaction.id}`
                );
            } catch (replyError) {
                logger.error(
                    `Failed to reply to interaction ${interaction.id}: ${replyError}`
                );
            }
            return;
        }

        // Set a timeout for the entire operation
        const timeoutMs = 120000; // 2 minutes timeout
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () => {
                    controller.abort();
                    reject(new Error('Operation timed out after 2 minutes'));
                },
                timeoutMs
            );
            timeoutId.unref?.();
        });

        try {
            const query = interaction.options.getString('query') ?? '';
            const category = interaction.options.getString('category') ?? '';
            const reasoningEffort =
                interaction.options.getString('reasoning_effort') ?? 'medium';
            const verbosity =
                interaction.options.getString('verbosity') ?? 'medium';
            const maxResults =
                interaction.options.getInteger('max_results') ??
                DEFAULT_MAX_RESULTS;

            // `/news` now delegates generation to the backend-owned task path,
            // so the bot stays out of provider selection and prompt assembly.
            const response = await Promise.race([
                botApi.runNewsTaskViaApi({
                    task: 'news',
                    query: query || undefined,
                    category: category || undefined,
                    maxResults,
                    reasoningEffort: reasoningEffort as
                        | 'minimal'
                        | 'low'
                        | 'medium'
                        | 'high',
                    verbosity: verbosity as 'low' | 'medium' | 'high',
                    channelContext: {
                        channelId: interaction.channelId ?? undefined,
                        guildId: interaction.guildId ?? undefined,
                    },
                }, { signal: controller.signal }),
                timeoutPromise,
            ]);

            const newsResponse = response.result as NewsResponse;
            if (!newsResponse.news || !Array.isArray(newsResponse.news)) {
                throw new Error('Invalid news response format');
            }

            if (logger.isLevelEnabled?.('debug')) {
                logger.debug('News response received', {
                    articleCount: newsResponse.news.length,
                    articlesWithThumbnails: newsResponse.news.filter(
                        (item) => Boolean(item.thumbnail)
                    ).length,
                    articlesWithImages: newsResponse.news.filter((item) =>
                        Boolean(item.image)
                    ).length,
                    articleTitles: newsResponse.news.map((item) => item.title),
                });
            }

            // Create embeds for each news item
            const embeds = newsResponse.news
                .slice(0, maxResults)
                .map((item) => {
                    const embed = new EmbedBuilder()
                        .setTitle(item.title)
                        .setDescription(item.summary)
                        .setURL(item.url)
                        .setFooter({
                            text: `Source: ${item.source} • ${new Date(item.timestamp).toLocaleString()}`,
                        });

                    if (item.thumbnail) {
                        embed.setThumbnail({ url: item.thumbnail });
                    }

                    return embed.build();
                });

            // Create a header message
            const searchParams = [];
            if (query) searchParams.push(`query: "${query}"`);
            if (category) searchParams.push(`category: "${category}"`);

            const headerMessage = `**News** ${searchParams.length ? `for ${searchParams.join(', ')}` : 'from around the world'}`;
            const resultMessage =
                newsResponse.summary ||
                `Found ${newsResponse.news.length} news items.`;

            await interaction.editReply({
                content: `${headerMessage}\n${resultMessage}`,
                embeds: embeds.slice(0, maxResults),
            });
        } catch (error) {
            logger.error(`Error in news command: ${error}`);
            try {
                if (isDeferred) {
                    await interaction.editReply(
                        'An error occurred while fetching news. Please try again later.'
                    );
                } else {
                    await interaction.reply({
                        content:
                            'An error occurred while fetching news. Please try again later.',
                        flags: [1 << 6], // EPHEMERAL
                    });
                }
            } catch (editError) {
                logger.error(`Failed to respond to interaction: ${editError}`);
            }
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    },
};

/**
 * Default export for Discord command registration.
 */
export default newsCommand;

