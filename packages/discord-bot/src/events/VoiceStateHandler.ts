import { Events, Client, VoiceState, ClientEvents } from 'discord.js';
import { Event } from './Event.js';
import { getVoiceConnection, VoiceConnection } from '@discordjs/voice';
import { RealtimeSession } from '../utils/realtimeService.js';
import { logger } from '../utils/logger.js';
import { VoiceSessionManager } from '../voice/VoiceSessionManager.js';
import { AudioCaptureHandler } from '../voice/AudioCaptureHandler.js';
import { AudioPlaybackHandler } from '../voice/AudioPlaybackHandler.js';
import { UserVoiceStateHandler } from '../voice/UserVoiceStateHandler.js';
import { VoiceConnectionManager } from '../voice/VoiceConnectionManager.js';

export class VoiceStateHandler extends Event {
    private sessionManager: VoiceSessionManager;
    private audioCaptureHandler: AudioCaptureHandler;
    private audioPlaybackHandler: AudioPlaybackHandler;
    private userVoiceStateHandler: UserVoiceStateHandler;
    private connectionManager: VoiceConnectionManager;
    private client: Client;

    constructor(client: Client) {
        super({
            name: Events.VoiceStateUpdate as keyof ClientEvents,
            once: false
        });

        this.client = client;
        this.sessionManager = new VoiceSessionManager();
        this.audioCaptureHandler = new AudioCaptureHandler();
        this.audioPlaybackHandler = new AudioPlaybackHandler();
        this.userVoiceStateHandler = new UserVoiceStateHandler();
        this.connectionManager = new VoiceConnectionManager();

        try {
            const anyClient = this.client as any;
            if (anyClient && anyClient.handlers && typeof anyClient.handlers.set === 'function') {
                anyClient.handlers.set('voiceState', this);
            }
        } catch {}
    }

    async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
        try {
            if (newState.member?.id === this.client.user?.id) {
                await this.handleBotVoiceStateChange(oldState, newState);
            } else {
                await this.userVoiceStateHandler.handleUserVoiceChange(
                    oldState,
                    newState,
                    this.client,
                    this.startConversation.bind(this)
                );
            }
        } catch (error) {
            logger.error('Error in VoiceStateHandler execute:', error);
        }
    }

    private async handleBotVoiceStateChange(oldState: VoiceState, newState: VoiceState): Promise<void> {
        if (!oldState.channelId && newState.channelId) {
            await this.handleBotJoinedChannel(newState);
        } else if (oldState.channelId && !newState.channelId) {
            await this.handleBotLeftChannel(oldState);
        }
    }

    private async handleBotJoinedChannel(newState: VoiceState): Promise<void> {
        const guildId = newState.guild.id;
        logger.info(`Bot joined voice channel ${newState.channelId} in guild ${guildId}`);

        if (this.sessionManager.hasSession(guildId)) {
            logger.debug(`Active session already exists for guild ${guildId}, skipping initialization`);
            return;
        }

        const connection = getVoiceConnection(guildId);
        if (!connection) {
            logger.warn(`No voice connection found for guild ${guildId} after join`);
            return;
        }

        const realtimeSession = await this.createRealtimeSession(guildId);

        const session = this.sessionManager.createSession(
            connection,
            realtimeSession,
            this.audioCaptureHandler,
            this.audioPlaybackHandler,
            this.userVoiceStateHandler.getInitiatingUser(guildId)
        );
        this.sessionManager.addSession(guildId, session);

        if (!this.audioCaptureHandler.isCaptureInitialized(guildId)) {
            this.audioCaptureHandler.setupAudioCapture(connection, realtimeSession, guildId);
        }

        logger.info('Voice session initialized successfully');
    }

    public registerInitiatingUser(guildId: string, userId: string): void {
        this.userVoiceStateHandler.registerInitiatingUser(guildId, userId);
    }

    public async createSession(guildId: string, channelId: string): Promise<void> {
        if (this.sessionManager.hasSession(guildId)) {
            logger.debug(`Active session already exists for guild ${guildId}, skipping creation`);
            return;
        }

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) throw new Error(`Guild ${guildId} not found`);

        const voiceChannel = guild.channels.cache.get(channelId);
        if (!voiceChannel?.isVoiceBased()) throw new Error(`Voice channel ${channelId} not found`);

        const connection = getVoiceConnection(guildId);
        if (!connection) throw new Error('No voice connection found for this guild');

        const realtimeSession = await this.createRealtimeSession(guildId);

        const session = this.sessionManager.createSession(
            connection,
            realtimeSession,
            this.audioCaptureHandler,
            this.audioPlaybackHandler,
            this.userVoiceStateHandler.getInitiatingUser(guildId)
        );
        this.sessionManager.addSession(guildId, session);

        this.audioCaptureHandler.setupAudioCapture(connection, realtimeSession, guildId);

        logger.info(`Voice session created for guild ${guildId} in channel ${channelId}`);
    }

    private async handleBotLeftChannel(oldState: VoiceState): Promise<void> {
        const guildId = oldState.guild.id;
        logger.info(`Bot left voice channel in guild ${guildId}`);

        const session = this.sessionManager.getSession(guildId);
        if (session?.realtimeSession) {
            this.removeRealtimeSessionListeners(session.realtimeSession);
        }

        this.sessionManager.removeSession(guildId);
        this.userVoiceStateHandler.clearInitiatingUser(guildId);
        this.audioCaptureHandler.cleanupGuild(guildId);
        this.audioPlaybackHandler.cleanupGuild(guildId);
    }

    private async startConversation(guildId: string): Promise<void> {
        let session = this.sessionManager.getSession(guildId);

        if (!session) {
            logger.info(`[VoiceStateHandler] No session exists, creating for guild ${guildId}`);
            const connection = getVoiceConnection(guildId);
            if (!connection) throw new Error('No voice connection found for this guild');

            const realtimeSession = await this.createRealtimeSession(guildId);
            session = this.sessionManager.createSession(
                connection,
                realtimeSession,
                this.audioCaptureHandler,
                this.audioPlaybackHandler,
                this.userVoiceStateHandler.getInitiatingUser(guildId)
            );
            this.sessionManager.addSession(guildId, session);
            this.audioCaptureHandler.setupAudioCapture(connection, realtimeSession, guildId);
        }

        try {
            logger.info(`Started conversation in guild ${guildId}`);
            session.realtimeSession.sendGreeting();
        } catch (error) {
            logger.error(`Error starting conversation in guild ${guildId}:`, error);
            throw error;
        }
    }

    private async createRealtimeSession(guildId: string): Promise<RealtimeSession> {
        this.audioCaptureHandler.cleanupGuild(guildId);

        const realtimeSession = new RealtimeSession({});

        // Attach listeners only once
        if (!(realtimeSession as any).listenersAttached) {
            (realtimeSession as any).listenersAttached = true;

            realtimeSession.on('audio', (audioData: Buffer) => {
                if (!audioData || audioData.length === 0) return;

                const session = this.sessionManager.getSession(guildId);
                if (!session) return;

                void this.audioPlaybackHandler.playAudioToChannel(session.connection, audioData)
                    .catch((error) => {
                        logger.error('[VoiceStateHandler] Error queuing realtime audio for playback:', error);
                    });
            });

            realtimeSession.on('text', (text: string) => logger.debug(`[BOT TEXT] ${text}`));
            realtimeSession.on('greeting', (text: string) => logger.info(`[BOT GREETING] ${text}`));
            realtimeSession.on('response.completed', (event: any) => logger.debug(`[BOT RESPONSE COMPLETED] Response ID: ${event?.response_id || 'unknown'}`));
            realtimeSession.on('response.output_audio.done', (event: any) => logger.debug('[BOT AUDIO DONE] Audio stream completed for ' + event));
            realtimeSession.on('error', (error: Error) => logger.error('[RealtimeSession] Error:', error));

            realtimeSession.on('connected', () => logger.info('[RealtimeSession] Connected to OpenAI Realtime API'));
        }

        await realtimeSession.connect();
        return realtimeSession;
    }

    private removeRealtimeSessionListeners(session: RealtimeSession) {
        session.removeAllListeners();
    }

    public async cleanupExistingConnections(): Promise<void> {
        await this.connectionManager.cleanupExistingConnections(this.client);
    }
}

export async function cleanupVoiceConnection(connection: VoiceConnection | null, client: Client): Promise<void> {
    const manager = new VoiceConnectionManager();
    return manager.cleanupVoiceConnection(connection, client);
}

export default VoiceStateHandler;