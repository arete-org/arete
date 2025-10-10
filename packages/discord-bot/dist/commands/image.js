import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { formatUsd } from '../utils/pricing.js';
import { buildPromptFieldValue, setEmbedFooterText, truncateForEmbed } from './image/embed.js';
import { imageConfig } from '../config/imageConfig.js';
// Pulling defaults from the constants module keeps the slash command aligned
// with any environment overrides exposed by imageConfig.
import { DEFAULT_IMAGE_MODEL, DEFAULT_TEXT_MODEL, PARTIAL_IMAGE_LIMIT, PROMPT_DISPLAY_LIMIT } from './image/constants.js';
import { resolveAspectRatioSettings } from './image/aspect.js';
import { buildImageResultPresentation, clampPromptForContext, createRetryButtonRow, executeImageGeneration, formatRetryCountdown, formatStylePreset, toTitleCase } from './image/sessionHelpers.js';
import { resolveImageCommandError } from './image/errors.js';
import { evictFollowUpContext, saveFollowUpContext } from './image/followUpCache.js';
import { buildTokenSummaryLine, consumeImageTokens, describeTokenAvailability, getImageTokenCost, refundImageTokens } from '../utils/imageTokens.js';
/**
 * Ensures that the interaction has been deferred before we begin streaming
 * updates to the reply.
 */
const ensureDeferredReply = async (interaction) => {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
    }
};
const QUALITY_LEVELS = ['low', 'medium', 'high'];
/**
 * Builds a human-friendly quality description that reflects the configured
 * token multipliers for each available image model.
 */
function buildQualityOptionDescription() {
    const summaries = Object.keys(imageConfig.tokens.modelTokenMultipliers)
        .sort()
        .map(model => {
        const typedModel = model;
        const costs = QUALITY_LEVELS.map(level => getImageTokenCost(level, typedModel));
        return `${typedModel}: ${costs.join('/')}`;
    });
    if (summaries.length === 0) {
        return 'Image quality (defaults to low)';
    }
    return `Image quality (${summaries.join(' • ')} tokens; defaults to low)`;
}
const QUALITY_OPTION_DESCRIPTION = buildQualityOptionDescription();
/**
 * Produces the initial set of status fields for the generation embed so that
 * the layout stays consistent across slash commands, retries, and planner flows.
 */
function buildInitialStatusFields(context, resolutionFieldValue, followUpResponseId) {
    const activePrompt = context.refinedPrompt ?? context.prompt;
    const originalPrompt = context.originalPrompt ?? context.prompt;
    const fields = [
        {
            name: 'Current prompt',
            value: buildPromptFieldValue(activePrompt, { label: 'current prompt' }),
            inline: false
        },
        {
            name: 'Original prompt',
            value: buildPromptFieldValue(originalPrompt, { label: 'original prompt' }),
            inline: false
        },
        {
            name: 'Image model',
            value: context.imageModel,
            inline: true
        },
        {
            name: 'Text model',
            value: context.textModel,
            inline: true
        },
        {
            name: 'Quality',
            value: `${toTitleCase(context.quality)} (${context.imageModel})`,
            inline: true
        },
        {
            name: 'Aspect ratio',
            value: context.aspectRatioLabel,
            inline: true
        },
        {
            name: 'Resolution',
            value: resolutionFieldValue,
            inline: true
        },
        {
            name: 'Background',
            value: toTitleCase(context.background),
            inline: true
        },
        {
            name: 'Prompt adjustment',
            value: context.allowPromptAdjustment ? 'Enabled' : 'Disabled',
            inline: true
        },
        {
            name: 'Style',
            value: formatStylePreset(context.style),
            inline: true
        },
        {
            name: 'Output ID',
            value: '…',
            inline: true
        }
    ];
    if (followUpResponseId) {
        fields.splice(fields.length - 1, 0, {
            name: 'Input ID',
            value: `\`${followUpResponseId}\``,
            inline: true
        });
    }
    return fields;
}
/**
 * Runs the end-to-end image generation flow and updates the interaction with
 * progress, results, and a follow-up button when successful.
 */
export async function runImageGenerationSession(interaction, context, followUpResponseId) {
    await ensureDeferredReply(interaction);
    const { prompt, textModel, imageModel, size, aspectRatioLabel, quality, background, style } = context;
    logger.debug(`Starting image generation session for user ${interaction.user.id} with text model ${textModel} and image model ${imageModel}.`);
    const resolutionFieldValue = size !== 'auto' ? size : 'Auto';
    const embed = new EmbedBuilder()
        .setTitle('🎨 Image Generation')
        .setColor(0x5865F2)
        .setTimestamp()
        .setDescription(truncateForEmbed(prompt, PROMPT_DISPLAY_LIMIT))
        .setFooter({ text: 'Generating…' });
    const statusFields = buildInitialStatusFields(context, resolutionFieldValue, followUpResponseId);
    embed.addFields(statusFields);
    await interaction.editReply({ embeds: [embed], components: [], files: [] });
    let editChain = Promise.resolve();
    const queueEmbedUpdate = (task) => {
        // Discord rate limits edits, so we serialise embed updates to preserve
        // ordering and to surface a single, easy-to-follow queue for future
        // contributors.
        editChain = editChain.then(async () => {
            try {
                await task();
            }
            catch (error) {
                logger.warn('Failed to update image preview embed:', error);
            }
        });
        return editChain;
    };
    try {
        const rawMember = interaction.member;
        const resolvedNickname = typeof rawMember === 'object' && rawMember !== null
            ? ('nickname' in rawMember && rawMember.nickname)
                || ('nick' in rawMember && typeof rawMember.nick === 'string' ? rawMember.nick : null)
            : null;
        const artifacts = await executeImageGeneration(context, {
            followUpResponseId,
            user: {
                username: interaction.user.username,
                nickname: resolvedNickname ?? interaction.user.displayName ?? interaction.user.username,
                guildName: interaction.guild?.name ?? `No guild for ${interaction.type} interaction`
            },
            onPartialImage: payload => queueEmbedUpdate(async () => {
                const previewName = `image-preview-${payload.index + 1}.png`;
                const attachment = new AttachmentBuilder(Buffer.from(payload.base64, 'base64'), { name: previewName });
                setEmbedFooterText(embed, `Rendering preview ${payload.index + 1}/${PARTIAL_IMAGE_LIMIT}…`);
                embed.setThumbnail(`attachment://${previewName}`);
                // Always clear previous attachments so Discord does not retain a
                // growing list of previews on the interaction response.
                await interaction.editReply({ embeds: [embed], files: [attachment], attachments: [] });
            })
        });
        await editChain;
        logger.debug(`Image generation usage - inputTokens: ${artifacts.usage.inputTokens}, outputTokens: ${artifacts.usage.outputTokens}, images: ${artifacts.usage.imageCount}, estimatedCost: ${formatUsd(artifacts.costs.total)}, textModel: ${artifacts.textModel}, imageModel: ${artifacts.imageModel}`);
        const presentation = buildImageResultPresentation(context, artifacts, { followUpResponseId });
        if (artifacts.responseId) {
            saveFollowUpContext(artifacts.responseId, presentation.followUpContext);
            if (followUpResponseId && followUpResponseId !== artifacts.responseId) {
                evictFollowUpContext(followUpResponseId);
            }
        }
        await interaction.editReply({
            content: presentation.content,
            embeds: [presentation.embed],
            files: presentation.attachments,
            attachments: [],
            components: presentation.components
        });
        return { success: true, responseId: artifacts.responseId };
    }
    catch (error) {
        await editChain;
        logger.error('Error in image generation session:', error);
        const errorMessage = resolveImageCommandError(error);
        try {
            await interaction.editReply({ content: `⚠️ ${errorMessage}`, embeds: [], files: [], components: [] });
        }
        catch (replyError) {
            logger.error('Failed to edit reply after image command error:', replyError);
            try {
                await interaction.followUp({ content: `⚠️ ${errorMessage}`, flags: [1 << 6], components: [] });
            }
            catch (followUpError) {
                logger.error('Failed to send follow-up after image command error:', followUpError);
            }
        }
        return { success: false, responseId: null };
    }
}
const imageCommand = {
    data: new SlashCommandBuilder()
        .setName('image')
        .setDescription('Generate an image based on the prompt provided')
        .addStringOption(option => option
        .setName('prompt')
        .setDescription('The prompt to generate the image from')
        .setRequired(true))
        .addBooleanOption(option => option
        .setName('adjust_prompt')
        .setDescription('Allow the AI to adjust the prompt prior to generation (defaults to true)')
        .setRequired(false))
        .addStringOption(option => option
        .setName('style')
        .setDescription('Image style preset (optional; defaults to unspecified)')
        // Keep the list to 24 presets so the variation select menu can include
        // an "Auto" entry and still satisfy Discord's 25-option limit.
        .addChoices({ name: 'Natural', value: 'natural' }, { name: 'Vivid', value: 'vivid' }, { name: 'Photorealistic', value: 'photorealistic' }, { name: 'Cinematic', value: 'cinematic' }, { name: 'Oil Painting', value: 'oil_painting' }, { name: 'Watercolor', value: 'watercolor' }, { name: 'Digital Painting', value: 'digital_painting' }, { name: 'Line Art', value: 'line_art' }, { name: 'Sketch', value: 'sketch' }, { name: 'Cartoon', value: 'cartoon' }, { name: 'Anime', value: 'anime' }, { name: 'Comic Book', value: 'comic' }, { name: 'Pixel Art', value: 'pixel_art' }, { name: 'Cyberpunk', value: 'cyberpunk' }, { name: 'Fantasy Art', value: 'fantasy_art' }, { name: 'Surrealist', value: 'surrealist' }, { name: 'Minimalist', value: 'minimalist' }, { name: 'Vintage', value: 'vintage' }, { name: 'Noir', value: 'noir' }, { name: '3D Render', value: '3d_render' }, { name: 'Steampunk', value: 'steampunk' }, { name: 'Abstract', value: 'abstract' }, { name: 'Pop Art', value: 'pop_art' }, { name: 'Isometric', value: 'isometric' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('aspect_ratio')
        .setDescription('The aspect ratio to use (optional; defaults to auto)')
        .addChoices({ name: 'Square', value: 'square' }, { name: 'Portrait', value: 'portrait' }, { name: 'Landscape', value: 'landscape' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('background')
        .setDescription('Image background (optional; defaults to auto)')
        .addChoices({ name: 'Auto', value: 'auto' }, { name: 'Transparent', value: 'transparent' }, { name: 'Opaque', value: 'opaque' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('quality')
        .setDescription(QUALITY_OPTION_DESCRIPTION)
        .addChoices({ name: 'Low', value: 'low' }, { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('image_model')
        .setDescription(`The image model to render with (optional; defaults to ${DEFAULT_IMAGE_MODEL})`)
        .addChoices({ name: 'gpt-image-1', value: 'gpt-image-1' }, { name: 'gpt-image-1-mini', value: 'gpt-image-1-mini' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('text_model')
        .setDescription(`The text model to use for prompt adjustment (optional; defaults to ${DEFAULT_TEXT_MODEL})`)
        .addChoices({ name: 'gpt-4.1', value: 'gpt-4.1' }, { name: 'gpt-4.1-mini', value: 'gpt-4.1-mini' }, { name: 'gpt-4.1-nano', value: 'gpt-4.1-nano' }, { name: 'gpt-4o', value: 'gpt-4o' }, { name: 'gpt-4o-mini', value: 'gpt-4o-mini' })
        .setRequired(false))
        .addStringOption(option => option
        .setName('follow_up_response_id')
        .setDescription('Response ID from a previous image generation for follow-up (optional)')
        .setRequired(false)),
    async execute(interaction) {
        const prompt = interaction.options.getString('prompt')?.trim();
        if (!prompt) {
            await interaction.reply({
                content: '⚠️ No prompt provided.',
                flags: [1 << 6]
            });
            return;
        }
        const normalizedPrompt = clampPromptForContext(prompt);
        if (prompt.length > normalizedPrompt.length) {
            logger.warn('Slash command prompt exceeded embed limits; truncating to preserve follow-up usability.');
        }
        logger.debug(`Received image generation request with prompt: ${normalizedPrompt}`);
        const aspectRatioOption = interaction.options.getString('aspect_ratio');
        const { size, aspectRatio, aspectRatioLabel } = resolveAspectRatioSettings(aspectRatioOption);
        const requestedQuality = interaction.options.getString('quality');
        const quality = requestedQuality ?? 'low';
        const textModel = interaction.options.getString('text_model') ?? DEFAULT_TEXT_MODEL;
        const imageModel = interaction.options.getString('image_model') ?? DEFAULT_IMAGE_MODEL;
        const background = interaction.options.getString('background') ?? 'auto';
        const style = interaction.options.getString('style') ?? 'unspecified';
        const adjustPrompt = interaction.options.getBoolean('adjust_prompt') ?? true;
        let followUpResponseId = interaction.options.getString('follow_up_response_id');
        if (followUpResponseId && !followUpResponseId.startsWith('resp_')) {
            followUpResponseId = `resp_${followUpResponseId}`;
            logger.warn(`Follow-up response ID was not prefixed with 'resp_'. Adding prefix: ${followUpResponseId}`);
        }
        const context = {
            prompt: normalizedPrompt,
            originalPrompt: normalizedPrompt,
            refinedPrompt: null,
            textModel,
            imageModel,
            size,
            aspectRatio,
            aspectRatioLabel,
            quality,
            background,
            style,
            allowPromptAdjustment: adjustPrompt
        };
        const developerBypass = interaction.user.id === process.env.DEVELOPER_USER_ID;
        // Spend image tokens up-front so that the command provides immediate feedback
        // when a user exceeds their allowance. On failure we refund below.
        let tokenSpend = null;
        if (!developerBypass) {
            const spendResult = consumeImageTokens(interaction.user.id, quality, imageModel);
            if (!spendResult.allowed) {
                const retryKey = `retry:${interaction.id}`;
                saveFollowUpContext(retryKey, context);
                const summary = buildTokenSummaryLine(interaction.user.id);
                const message = `${describeTokenAvailability(quality, spendResult, imageModel)}\n\n${summary}`;
                const countdown = spendResult.refreshInSeconds;
                const components = countdown > 0
                    ? [createRetryButtonRow(retryKey, formatRetryCountdown(countdown))]
                    : [];
                await interaction.reply({ content: message, components, flags: [1 << 6] });
                return;
            }
            tokenSpend = spendResult;
        }
        const result = await runImageGenerationSession(interaction, context, followUpResponseId ?? undefined);
        if (!result.success && tokenSpend) {
            refundImageTokens(interaction.user.id, tokenSpend.cost);
        }
    }
};
export default imageCommand;
//# sourceMappingURL=image.js.map