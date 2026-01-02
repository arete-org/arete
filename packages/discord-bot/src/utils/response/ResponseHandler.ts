/**
 * @description: Orchestrates Discord responses (messages, embeds, DMs, reactions, typing).
 * @arete-scope: interface
 * @arete-module: ResponseHandler
 * @arete-risk: high - Response failures can drop user interactions or spam channels.
 * @arete-ethics: moderate - Response handling affects user transparency and feedback.
 */

import { Message, MessageCreateOptions, MessageReplyOptions, EmbedBuilder as DiscordEmbedBuilder, TextBasedChannel, User, MessageEditOptions, ActivityOptions } from 'discord.js';
import { logger } from '../logger.js';
import { EmbedBuilder as CustomEmbedBuilder } from './EmbedBuilder.js';
import { runOutboundFilters } from '../../filters/outbound/index.js';

/**
 * Handles various types of message responses for Discord interactions.
 * Manages text responses, embeds, direct messages, reactions, and typing indicators.
 * @class ResponseHandler
 */
export class ResponseHandler {
  private typingInterval: NodeJS.Timeout | null = null;
  private readonly TYPING_INTERVAL_MS = 8000; // Discord typing indicator lasts ~10s, so we'll refresh at 8s

  /**
   * Creates an instance of ResponseHandler.
   * @param {Message} message - The original Discord message that triggered the response
   * @param {TextBasedChannel} channel - The channel where the message was received
   * @param {User} user - The user who sent the original message
   */
  constructor(
    private readonly message: Message,
    private readonly channel: TextBasedChannel,
    private readonly user: User
  ) {}

  /**
   * Sends a message to the channel with optional file attachments
   * @param {string} content - The message content to send
   * @param {Array<{filename: string, data: string | Buffer}>} [files=[]] - Optional files to attach
   * @param {boolean} [directReply=false] - Whether to reply to the triggering message
   * @param {boolean} [suppressEmbeds=true] - Whether to suppress automatic embed rendering
   * @param {MessageCreateOptions['components']} [components=[]] - Message components to include on the final chunk
   * @param {DiscordEmbedBuilder[]} [embeds=[]] - Embeds to attach to the last chunk of the message
   * @param {MessageCreateOptions['components']} [embedComponents=[]] - Components associated with the embeds, merged into the final chunk
   * @returns {Promise<Message | Message[]>} The sent message(s)
   */
  public async sendMessage(
    content: string,
    files: Array<{filename: string, data: string | Buffer}> = [],
    directReply: boolean = false,
    suppressEmbeds: boolean = true,
    components: MessageCreateOptions['components'] = [],
    embeds: DiscordEmbedBuilder[] = [],
    embedComponents: MessageCreateOptions['components'] = []
  ): Promise<Message | Message[]> {
    if (!this.channel.isSendable()) {
      throw new Error('Channel is not sendable');
    }
  
    try {
      // Apply outbound filters before chunking so formatting stays consistent.
      const filteredContent = this.applyOutboundFilters(content);

      // Split the message into chunks if it exceeds Discord's limits for a single message
      let chunks = this.splitMessage(filteredContent);
      const messages: Message[] = [];
      const hasEmbeds = embeds.length > 0;
      const hasComponents = (components?.length ?? 0) > 0 || (embedComponents?.length ?? 0) > 0;
      const hasFiles = files && files.length > 0;

      if (chunks.length === 0 && (hasEmbeds || hasComponents || hasFiles)) {
        // Discord expects at least an empty string when sending embeds/components without body text.
        chunks = [''];
      }
  
      // Send each chunk as a separate message
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isFirstChunk = i === 0;
        const isLastChunk = i === chunks.length - 1;
        const chunkHasFiles = hasFiles;
  
        // Create base message options
        const messageOptions: MessageCreateOptions = {
          content: chunk,
          flags: suppressEmbeds && embeds.length === 0 ? ['SuppressEmbeds'] : undefined
        };

        // Attach embeds and components only to the last chunk
        if (isLastChunk) {
          if (embeds.length > 0) {
            messageOptions.embeds = embeds;
          }

          const finalComponents = [
            ...(components ?? []),
            ...(embedComponents ?? [])
          ];

          if (finalComponents.length > 0) {
            messageOptions.components = finalComponents;
          }
        }
  
        // Add message reference for replies
        if (isFirstChunk && directReply) {
          messageOptions.reply = {
            messageReference: this.message.id,
            failIfNotExists: false
          };
        }
  
        // Add files if this is the last chunk and there are files
        if (isLastChunk && chunkHasFiles) {
          messageOptions.files = files.map(f => ({
            attachment: Buffer.from(f.data),
            name: f.filename
          }));
        }

        logger.debug(`Sending message to channel ${this.channel.id}(${this.channel.type} type) with options: ${JSON.stringify(messageOptions)}`);
  
        // Send the message
        messages.push(await this.channel.send(messageOptions));
      }
  
      return messages.length === 1 ? messages[0] : messages;
    } catch (error) {
      logger.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Sends a single embed with optional attachments and interactive components.
   * This is primarily used by automated image responses so we can ship the
   * generated asset, metadata attachment, and variation buttons in one payload.
   */
  public async sendEmbedMessage(
    embed: DiscordEmbedBuilder,
    {
      content,
      files = [],
      directReply = false,
      components
    }: {
      content?: string;
      files?: Array<{ filename: string; data: string | Buffer }>;
      directReply?: boolean;
      components?: MessageCreateOptions['components'];
    } = {}
  ): Promise<Message> {
    if (!this.channel.isSendable()) {
      throw new Error('Channel is not sendable');
    }

    // Normalize optional content without altering the embed payload.
    const filteredContent = content ? this.applyOutboundFilters(content) : content;

    const messageOptions: MessageCreateOptions = {
      embeds: [embed],
      content: filteredContent,
      components
    };

    if (directReply) {
      messageOptions.reply = {
        messageReference: this.message.id,
        failIfNotExists: false
      };
    }

    if (files.length > 0) {
      messageOptions.files = files.map(file => ({
        attachment: Buffer.from(file.data),
        name: file.filename
      }));
    }

    return this.channel.send(messageOptions);
  }

  /**
   * Sends an embedded message to the channel where the message was received.
   * @param {CustomEmbedBuilder | DiscordEmbedBuilder} embed - The embed to send
   * @param {Omit<MessageReplyOptions, 'embeds'>} [options] - Additional message options
   * @returns {Promise<void>}
   */
  public async sendEmbed(
    embed: CustomEmbedBuilder | DiscordEmbedBuilder,
    options: Omit<MessageReplyOptions, 'embeds'> = {}
  ): Promise<void> {
    let discordEmbed: DiscordEmbedBuilder;
    
    try {
      discordEmbed = embed instanceof CustomEmbedBuilder 
        ? new DiscordEmbedBuilder(embed.toJSON())
        : embed;

      if (this.channel.isSendable()) {
        await this.channel.send({
          ...options,
          embeds: [discordEmbed]
        });
      } else {
        throw new Error('Channel is not sendable'); // TODO: Handle non-text channels
      }
    } catch (error) {
      logger.error('Failed to send embed:', error);
      throw error;
    }
  }

  /**
   * Sends a direct message to the user who sent the original message.
   * Falls back to a channel message if DMs are disabled.
   * @param {string | MessageCreateOptions} content - The message content or options
   * @returns {Promise<void>}
   */
  public async sendDM(content: string | MessageCreateOptions): Promise<void> {
    try {
      const dmChannel = await this.user.createDM();
      // Apply outbound filters to DM content to keep formatting consistent.
      const dmPayload = typeof content === 'string'
        ? this.applyOutboundFilters(content)
        : this.applyOutboundFiltersToOptions(content);
      await dmChannel.send(dmPayload);
    } catch (error) {
      logger.error('Failed to send DM:', error);
      // Fall back to public channel if DM fails
      if (typeof content === 'string') {
        await this.sendMessage(`Sorry, I couldn't send you a DM.\n> ${content}`);
      } else {
        await this.sendMessage("Sorry, I couldn't send you a DM.");
      }
    }
  }

  /**
   * Edits an existing message in the channel.
   * @param {string} messageId - The ID of the message to edit
   * @param {string | MessageEditOptions} content - The new content or options
   * @returns {Promise<void>}
   * @throws Will throw an error if the message cannot be edited
   */
  public async editMessage(messageId: string, content: string | MessageEditOptions): Promise<void> {
    try {
      const message = await this.channel.messages.fetch(messageId);
      if (message.editable) {
        await message.edit(content);
      }
    } catch (error) {
      logger.error('Failed to edit message:', error);
      throw error;
    }
  }

  /**
   * Adds a reaction to the original message.
   * @param {string} emoji - The emoji to react with
   * @returns {Promise<void>}
   */
  public async addReaction(emoji: string): Promise<void> {
    if (!emoji?.trim()) return;
  
    const MAX_REACTIONS = 20; // Discord's limit
    const isEmoji = (str: string): boolean => {
      const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;
      return emojiRegex.test(str);
    };
  
    try {
      let reactionCount = 0;
      
      for (const char of emoji) {
        if (reactionCount >= MAX_REACTIONS) {
          logger.debug(`Reached maximum of ${MAX_REACTIONS} reactions`);
          break;
        }
        
        if (isEmoji(char)) {
          try {
            await this.message.react(char);
            reactionCount++;
            await new Promise(resolve => setTimeout(resolve, 300));
          } catch (error) {
            logger.warn(`Failed to react with emoji ${char}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error('Error adding reactions:', error);
      throw error;
    }
  }

  /**
   * Shows a typing indicator in the channel.
   * The indicator will automatically disappear after ~10 seconds or when a message is sent.
   * @returns {Promise<void>}
   */
  public async indicateTyping(): Promise<void> {
    // Only valid for text-based channels
    if (!this.channel.isTextBased() || this.channel.isDMBased() || this.channel.isThread()) {
      return;
    }
    
    try {
      await this.channel.sendTyping();
    } catch (error) {
      logger.warn('Failed to send typing indicator:', error);
    }
  }

  /**
   * Shows a typing indicator in the channel and keeps it active until stopTyping is called
   * @returns {Promise<void>}
   */
  public async startTyping(): Promise<void> {
    if (!this.channel.isTextBased() || this.channel.isDMBased() || this.channel.isThread()) {
      return;
    }

    // Type guard to ensure we have a text channel that supports sendTyping
    const textChannel = this.channel as Extract<TextBasedChannel, { sendTyping: unknown }>;
    
    // Send initial typing indicator
    try {
      await textChannel.sendTyping();
    } catch (error) {
      logger.warn('Failed to send typing indicator:', error);
      return;
    }

    // Set up interval to keep typing active
    this.typingInterval = setInterval(async () => {
      try {
        await textChannel.sendTyping();
      } catch (error) {
        logger.warn('Failed to refresh typing indicator:', error);
        this.stopTyping();
      }
    }, this.TYPING_INTERVAL_MS);
  }

  /**
   * Stops the typing indicator
   * @returns {void}
   */
  public stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  /**
   * Sets the bot's presence with customizable options.
   *
   * @param {Object} options - Presence configuration options
   * @param {'online'|'idle'|'dnd'|'invisible'} [options.status='online']
   *        The overall status of the bot.
   * @param {Array<ActivityOptions>} [options.activities=[]]
   *        Array of activity objects to display (e.g. "Playing X").
   * @param {number|null} [options.shardId=null]
   *        The shard ID to apply the presence to. Optional, and usually not needed
   *        unless the bot is running with multiple shards. If omitted or null,
   *        the presence applies globally.
   * @param {boolean} [options.afk=false]
   *        Whether the bot should be flagged as AFK.
   * @returns {void}
   *
   * @example
   * // Basic example: playing a game
   * setPresence({
   *   status: 'online',
   *   activities: [{ name: 'with TypeScript', type: ActivityType.Playing }],
   *   afk: false
   * });
   *
   * @example
   * // Advanced: streaming
   * setPresence({
   *   status: 'dnd',
   *   activities: [{ name: 'my coding stream', type: ActivityType.Streaming, url: 'https://twitch.tv/mychannel' }]
   * });
   */
  public setPresence({
    status = 'online',
    activities = [],
    shardId = null,
    afk = false,
  }: {
    status?: 'online' | 'idle' | 'dnd' | 'invisible';
    activities?: ActivityOptions[];
    shardId?: number | null;
    afk?: boolean;
  } = {}): void {
    try {
      const client = this.message.client;

      client.user?.setPresence({
        status,
        activities,
        shardId: shardId ?? undefined,
        afk,
      });

      logger.info(`Presence updated: ${status} with ${activities.length} activities`);
    } catch (error) {
      logger.warn('Failed to set presence:', error); // Not a high-severity error
    }
  }

  /**
   * Applies outbound filters with context so downstream logs stay traceable.
   */
  private applyOutboundFilters(content: string): string {
    const result = runOutboundFilters(content, {
      channelId: this.channel.id,
      messageId: this.message.id,
      userId: this.user.id
    });

    return result.content;
  }

  /**
   * Applies outbound filters to MessageCreateOptions without mutating the input.
   */
  private applyOutboundFiltersToOptions(options: MessageCreateOptions): MessageCreateOptions {
    if (!options.content) {
      return options;
    }

    return {
      ...options,
      content: this.applyOutboundFilters(options.content)
    };
  }

  /**
   * Splits a message into chunks that fit within Discord's message limits
   * @private
   */
  private splitMessage(text: string): string[] {
    const maxLength = 2000;
    const chunks: string[] = [];
    let currentChunk = '';
    
    // First, handle code blocks specially
    const codeBlockRegex = /(```[a-z]*\n[\s\S]*?\n```)/g;
    const parts = text.split(codeBlockRegex);
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.trim()) continue;
        
        // Check if this part is a complete code block
        const isCodeBlock = part.startsWith('```') && part.endsWith('```') && part.split('\n').length > 2;
        
        if (isCodeBlock) {
            // If code block is too large, split it specially
            if (part.length > maxLength) {
                // Push current chunk if not empty
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                
                // Split the code block into multiple chunks
                const codeContent = part.slice(3, -3); // Remove the ``` markers
                const language = part.split('\n')[0].slice(3).trim() || '';
                const codeLines = codeContent.split('\n');
                let codeChunk = `\`\`\`${language}\n`;
                
                for (const line of codeLines) {
                    // If adding this line would exceed max length, start a new chunk
                    if (codeChunk.length + line.length + 1 > maxLength - 3) { // -3 for the ```
                        // Close current code block
                        codeChunk += '\n```';
                        chunks.push(codeChunk);
                        
                        // Start new code block
                        codeChunk = `\`\`\`${language}\n${line}\n`;
                    } else {
                        codeChunk += `${line}\n`;
                    }
                }
                
                // Add the last code block if there's any content left
                if (codeChunk.length > language.length + 5) { // 5 = ``` + \n + \n
                    if (!codeChunk.endsWith('\n```')) {
                        codeChunk += '```';
                    }
                    currentChunk = codeChunk;
                }
            } 
            // If code block fits in current chunk, add it
            else if (currentChunk.length + part.length + 2 <= maxLength) {
                currentChunk += (currentChunk ? '\n\n' : '') + part;
            } 
            // Otherwise, start a new chunk
            else {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = part;
            }
        } 
        // Handle non-code block text
        else {
            const paragraphs = part.split(/\n\s*\n/);
            
            for (const paragraph of paragraphs) {
                // If adding this paragraph would exceed the limit, push current chunk
                if (currentChunk && currentChunk.length + paragraph.length + 2 > maxLength) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                
                // If a single paragraph is too long, split it by words
                if (paragraph.length > maxLength) {
                    const words = paragraph.split(/\s+/);
                    
                    for (const word of words) {
                        if (currentChunk.length + word.length + 1 > maxLength) {
                            chunks.push(currentChunk.trim());
                            currentChunk = word;
                        } else {
                            currentChunk += (currentChunk ? ' ' : '') + word;
                        }
                    }
                } 
                // Otherwise add the paragraph
                else {
                    currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
                }
            }
        }
    }
    
    // Add the last chunk if it's not empty
    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }
}
