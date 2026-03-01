/**
 * @description: Initiates voice conversations with AI using Discord voice channels.
 * @footnote-scope: interface
 * @footnote-module: CallCommand
 * @footnote-risk: high - Handles voice channel joining, connection management, and realtime session creation; failures can orphan connections or break voice functionality.
 * @footnote-ethics: high - Enables AI participation in voice channels, affecting user privacy, consent, and social dynamics.
 */

import { logger } from '../utils/logger.js';
import { Command } from './BaseCommand.js';
import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    ChannelType,
    VoiceChannel,
    PermissionResolvable,
} from 'discord.js';
import {
    entersState,
    getVoiceConnection,
    getVoiceConnections,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
} from '@discordjs/voice';
import {
    VoiceStateHandler,
    cleanupVoiceConnection,
} from '../events/VoiceStateHandler.js';

/**
 * @name call
 * @description: Have a voice conversation with the AI using Discord's voice features
 * @usage /call <voice channel>
 * 1. Check if the bot is already in a voice channel in this server/guild (Discord limitation: only one voice channel at a time per server/guild) - If yes, give the user an error message
 * 2. Try to join the voice channel provided - If it fails, give the user an error message
 * 3. Invite the user to join the voice channel
 * 4. On the target user joining the voice channel, start the realtime conversation
 */
const callCommand: Command = {
    data: new SlashCommandBuilder()
        .setName('call')
        .setDescription(
            "Have a voice conversation with the AI using Discord's voice features"
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('The voice channel to join')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildVoice)
        )
        .addStringOption((option) =>
            option // Debug options only available to the bot owner/superuser
                .setName('debug_options')
                .setDescription(
                    'Debug options only available to the bot owner/superuser'
                )
                .addChoices(
                    { name: 'Exit', value: 'exit' }, // Terminate the voice connection for this server/guid
                    { name: 'ExitAll', value: 'exit_all' } // Terminate all voice connections
                )
                .setRequired(false)
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        // Store the voice channel we want to use
        const voiceChannel = interaction.options.getChannel('channel', true, [
            ChannelType.GuildVoice,
        ]) as VoiceChannel;
        let voiceConnection: VoiceConnection | null = null;

        const debugOption = interaction.options.getString('debug_options');

        // Check rate limit per user, channel, and guild
        // Bypass for developer user
        if (
            interaction.user.id !== process.env.DISCORD_USER_ID &&
            debugOption
        ) {
            // TODO - Implement rate limiter.
            // We aren't the bot owner/superuser, but we have debug options listed - Give the user an error message
            logger.warn(
                `User ${interaction.user.id} is trying to use debug options for the call command.`
            );
            await safeReply(
                interaction,
                'You do not have permission to use debug options for this command.'
            );
            return;
        }

        // If we have debug options, activate them
        if (debugOption) {
            switch (debugOption) {
                case 'exit': {
                    const existingVoiceConnection = getVoiceConnection(
                        interaction.guild!.id
                    ) as VoiceConnection;
                    if (existingVoiceConnection) {
                        cleanupVoiceConnection(
                            existingVoiceConnection,
                            interaction.client
                        );
                        logger.info(
                            `Exiting voice connection ${existingVoiceConnection} in guild ${interaction.guild!.id}`
                        );
                        await safeReply(
                            interaction,
                            'Voice connection exited successfully.'
                        );
                    } else {
                        logger.info(
                            `I was unable to exit the voice connection. I am not in a voice channel.`
                        );
                        await safeReply(
                            interaction,
                            'I was unable to exit the voice connection. I am not in a voice channel.'
                        );
                    }
                    return;
                }
                case 'exit_all': {
                    const existingVoiceConnections: Map<
                        string,
                        VoiceConnection
                    > = getVoiceConnections();
                    if (existingVoiceConnections) {
                        existingVoiceConnections.forEach(
                            (existingVoiceConnection, guildid) => {
                                logger.info(
                                    `Exiting voice connection ${existingVoiceConnection} in guild ${guildid}`
                                );
                                cleanupVoiceConnection(
                                    existingVoiceConnection,
                                    interaction.client
                                );
                            }
                        );
                        logger.info(
                            `All voice connections exited successfully.`
                        );
                        await safeReply(
                            interaction,
                            'All voice connections exited successfully.'
                        );
                    } else {
                        logger.info(
                            `I was unable to exit all voice connections. I am not in any voice channels.`
                        );
                        await safeReply(
                            interaction,
                            'I was unable to exit all voice connections. I am not in any voice channels.'
                        );
                    }
                    return;
                }
            }
        }

        // Defer the interaction
        await interaction.deferReply({ flags: [1 << 6] }); // flags: [1 << 6] = EPHEMERAL

        // 1. Check bot permissions
        const botMember = interaction.guild!.members.me!;
        const requiredPermissions = [
            'Connect',
            'Speak',
            'UseVAD',
            'CreateInstantInvite',
        ];
        const missingPermissions = requiredPermissions.filter(
            (perm) => !botMember.permissions.has(perm as PermissionResolvable)
        );
        if (missingPermissions.length > 0) {
            return await safeReply(
                interaction,
                `Missing permissions: ${missingPermissions.join(', ')}`
            );
        }

        // 2. Check if channel is viewable
        if (!voiceChannel.viewable) {
            return await safeReply(
                interaction,
                `I can't see ${voiceChannel.name}. Please check the channel permissions.`
            );
        }

        // 3. Check if the channel is joinable
        if (!voiceChannel.joinable) {
            return await safeReply(
                interaction,
                `I don't have permission to join ${voiceChannel.name}. Please check my permissions.`
            );
        }

        // 4. Check if channel is full
        if (voiceChannel.full) {
            return await safeReply(
                interaction,
                `I can't join ${voiceChannel.name} because it is full.`
            );
        }

        // 5. Check if the bot is already in a voice channel
        if (botMember.voice.channel) {
            return await safeReply(
                interaction,
                `I am already in voice channel ${botMember.voice.channel.name} - Please try again later!`
            );
        }

        logger.debug(
            `Passed all checks (bot has permissions, channel is viewable/joinable/not full, not already in a VC) - Attempting to join ${voiceChannel.name}`
        );

        try {
            // Join voice channel
            voiceConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false,
            });

            // Get the VoiceStateHandler instance from the client
            if (!interaction.client.handlers) {
                const message = 'Client handlers not initialized';
                await safeReply(interaction, message);
                throw new Error(message);
            }

            const voiceStateHandler = interaction.client.handlers.get(
                'voiceState'
            ) as VoiceStateHandler | undefined;
            if (!voiceStateHandler) {
                const message = 'VoiceStateHandler not found';
                await safeReply(interaction, message);
                throw new Error(message);
            }

            // Register the initiating user
            voiceStateHandler.registerInitiatingUser(
                voiceChannel.guild.id,
                interaction.user.id
            );
            logger.debug(
                `Registered initiating user ${interaction.user.id} for guild ${voiceChannel.guild.id}`
            );

            // Create the session
            await voiceStateHandler.createSession(
                voiceChannel.guild.id,
                voiceChannel.id
            );

            // Wait for the connection to be ready
            try {
                await entersState(
                    voiceConnection,
                    VoiceConnectionStatus.Ready,
                    10_000
                );
                logger.info(`Successfully joined ${voiceChannel.name}`);

                // Double-check the bot is actually in the voice channel
                const botMember = voiceChannel.guild.members.me;
                if (!botMember?.voice.channel) {
                    const message =
                        'Bot is not in a voice channel after joining';
                    await safeReply(interaction, message);
                    throw new Error(message);
                }

                // Update the deferred reply with success message
                await safeReply(
                    interaction,
                    `I have joined ${voiceChannel.name} - Meet me there!`
                );

                // Log the current voice state
                logger.debug(
                    `Bot voice state after join: ${botMember.voice.channel.id} (${botMember.voice.channel.name})`
                );
            } catch (error) {
                const errorMessage = `Failed to connect to voice channel ${voiceChannel.name}: ${error}`;
                logger.error(errorMessage, error);
                await safeReply(interaction, errorMessage);
                throw new Error(errorMessage);
            }

            // Handle disconnections
            voiceConnection.on(
                VoiceConnectionStatus.Disconnected,
                async (oldState, newState) => {
                    logger.warn(
                        `Voice connection status changed: ${oldState} -> ${newState}`
                    );

                    try {
                        // Try to reconnect if it was a temporary disconnection
                        if (voiceConnection) {
                            await Promise.race([
                                entersState(
                                    voiceConnection,
                                    VoiceConnectionStatus.Signalling,
                                    5_000
                                ),
                                entersState(
                                    voiceConnection,
                                    VoiceConnectionStatus.Connecting,
                                    5_000
                                ),
                            ]);
                            logger.info(
                                'Successfully reconnected to voice channel'
                            );
                        } else {
                            throw new Error(
                                'Cannot reconnect - Voice connection is null'
                            );
                        }
                    } catch (error) {
                        logger.error(`Permanent voice disconnection: ${error}`);
                        voiceConnection?.destroy();
                        interaction.followUp({
                            content: `I was unable to maintain a connection to the voice channel ${voiceChannel.name}. Please try again.`,
                            flags: [1 << 6],
                        });
                    }
                }
            );

            // Handle other connection states
            voiceConnection.on(VoiceConnectionStatus.Destroyed, () => {
                logger.info(
                    `Voice connection in VC ${voiceChannel.name} was destroyed`
                );
            });
            voiceConnection.on('error', (error) => {
                logger.error(
                    `Voice connection error in VC ${voiceChannel.name}:`,
                    error
                );
            });

            // Invite the user to join the voice channel
            voiceChannel
                .createInvite()
                .then((invite) => {
                    interaction.followUp({
                        content: `Join the call by clicking this link: ${invite.url}`,
                        flags: [1 << 6],
                    });
                })
                .catch((error) => {
                    logger.error(
                        `Failed to create voice channel invite:`,
                        error
                    );
                    interaction.followUp({
                        content: `Failed to create invite: ${error}`,
                        flags: [1 << 6],
                    });
                });
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            logger.error(
                `Error in voice connection in guild ${interaction.guild!.id} and channel ${voiceChannel.name}:`,
                error
            );
            await safeReply(interaction, `Error: ${errorMessage}`);
            cleanupVoiceConnection(voiceConnection, interaction.client); // Clean up the connection
        }
    },
};

const safeReply = async (
    interaction: ChatInputCommandInteraction,
    content: string
) => {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply({ content, flags: 1 << 6 });
        }
    } catch (error) {
        logger.error('Failed to send reply safely:', error);
    }
};

export default callCommand;

