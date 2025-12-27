/**
 * @description: Manages Discord voice connections and cleanup routines.
 * @arete-scope: core
 * @arete-module: VoiceConnectionManager
 * @arete-risk: high - Connection leaks can destabilize voice playback or capture.
 * @arete-ethics: high - Voice connection control affects consent and session boundaries.
 */
import { VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { Client } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getVoiceConnection } from '@discordjs/voice';

export class VoiceConnectionManager {

    constructor() {
        // Initialize
    }

    /**
     * Cleans up any existing voice connections that might be lingering from a previous session
     */
    public async cleanupExistingConnections(client: Client): Promise<void> {
        try {
            if (!client.isReady?.()) {
                logger.warn('Client is not ready, skipping connection cleanup');
                return;
            }

            logger.info('Cleaning up any existing voice connections...');

            let cleanedCount = 0;

            // Check all guilds the bot is in
            for (const [guildId, guild] of client.guilds.cache) {
                try {
                    const member = await guild.members.fetchMe();
                    if (member?.voice.channel) {
                        logger.warn(`Found bot in voice channel ${member.voice.channel.name} (${guild.name}) - cleaning up`);
                        const connection = getVoiceConnection(guildId);
                        if (connection) {
                            logger.debug(`Cleaning up connection in guild ${guild.name} (${guildId})`);
                            await this.cleanupVoiceConnection(connection, client);
                            logger.debug(`Successfully cleaned up connection in guild ${guild.name}`);
                            cleanedCount++;
                        }
                    }
                } catch (error) {
                    logger.error(`Error cleaning up voice connection in guild ${guild.name} (${guildId}):`, error);
                }
            }
            logger.info(`Cleaned ${cleanedCount} voice connections`);
        } catch (error) {
            logger.error('Unexpected error in cleanupExistingConnections:', error);
            throw error;
        }
    }

    /**
     * Cleans up a specific voice connection
     */
    public async cleanupVoiceConnection(connection: VoiceConnection | null, client: Client): Promise<void> {
        if (!connection) {
            logger.warn('No voice connection found to clean up');
            return;
        }

        try {
            const guildId = connection.joinConfig.guildId;
            logger.debug(`[cleanupVoiceConnection] Starting cleanup for guild ${guildId}`);

            // Stop any ongoing audio playback
            try {
                const subscription = connection.state.status === VoiceConnectionStatus.Ready
                    ? connection.state.subscription
                    : null;
                if (subscription) {
                    logger.debug('[cleanupVoiceConnection] Unsubscribing from audio subscription');
                    subscription.unsubscribe();
                    logger.debug('[cleanupVoiceConnection] Attempting to stop audio player');
                    subscription.player?.stop(true);
                }
            } catch (error) {
                logger.error('Error stopping audio playback:', error);
            }

            // Destroy the connection
            logger.debug('[cleanupVoiceConnection] Destroying voice connection');
            connection.destroy();

            // Leave the voice channel if possible
            if (client.isReady?.()) {
                try {
                    const guild = client.guilds.cache.get(guildId);
                    if (guild) {
                        const member = guild.members.me;
                        if (member?.voice.channel) {
                            logger.debug(`[cleanupVoiceConnection] Disconnecting from voice channel ${member.voice.channel.name}`);
                            await member.voice.disconnect('Cleaning up old connection');
                        }
                    }
                } catch (error) {
                    logger.error('Error disconnecting from voice channel:', error);
                }
            }

            logger.debug(`[cleanupVoiceConnection] Successfully cleaned up connection for guild ${guildId}`);
        } catch (error) {
            logger.error('Error in cleanupVoiceConnection:', error);
            throw error;
        }
    }
}

/**
 * Cleans up a specific voice connection (standalone function for backward compatibility)
 */
export async function cleanupVoiceConnection(connection: VoiceConnection | null, client: Client): Promise<void> {
    const manager = new VoiceConnectionManager();
    return manager.cleanupVoiceConnection(connection, client);
}
