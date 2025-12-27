/**
 * @arete-module: CatchupFilter
 * @arete-risk: moderate
 * @arete-ethics: moderate
 * @arete-scope: utility
 *
 * @description: Provides lightweight, deterministic heuristics that decide whether the planner
 * should be skipped for catchup events. The filter analyzes recent conversation
 * history to weed out obvious non-response scenarios before we incur an LLM call.
 *
 * @impact
 * Risk: Overly aggressive heuristics could cause the bot to miss legitimate
 * engagement opportunities. The filter intentionally fails open to minimise risk.
 * Ethics: Reduces unnecessary AI engagement, lowering the chance of spamming or
 * intruding on human-only conversations.
 */

import { Message } from 'discord.js';
import { logger } from './logger.js';
import type { OpenAIService } from './openaiService.js';

type CatchupFilterDecision = { skip: boolean; reason: string };

// ---------------------------------------------------------------------------
// Lightweight lexical signal sets
// ---------------------------------------------------------------------------

// Short greetings that remain meaningful even when repeated.
const GREETING_WHITELIST = new Set([
  'hey',
  'yo',
  'hi',
  'hello'
]);

// Common acknowledgement tokens that rarely need a reply when stacked together.
const NON_SUBSTANTIVE_EXPRESSIONS = new Set([
  'lol',
  'lmao',
  'lmfao',
  'rofl',
  'ok',
  'k',
  'kk',
  'okay',
  'haha',
  'hahaha',
  'ha',
  'h',
  'hm',
  'hmm',
  'hmmm',
  'huh',
  'sup',
  'bruh',
  'bro',
  'sure',
  'yep',
  'yup',
  'nope',
  'nah',
  'ikr',
  'idk',
  'gg'
]);

// Keywords that suggest the speakers are asking for help or discussing work.
export const TECHNICAL_KEYWORDS = [
  'error',
  'issue',
  'fix',
  'bug',
  'stack',
  'trace',
  'http',
  'api',
  'code',
  'function',
  'class',
  'design',
  'plan',
  'update',
  'help',
  'explain',
  'show',
  'tell'
];

/**
 * Applies deterministic heuristics before we incur an LLM cost. The filter
 * errs on the side of letting the planner run, but skips obvious non-response
 * scenarios where the bot would add noise.
 */
export class CatchupFilter {
  public readonly RECENT_MESSAGE_WINDOW = 8;
  public readonly EMOJI_ONLY_THRESHOLD = 3;
  public readonly HIGH_VELOCITY_THRESHOLD = 5;
  private readonly HIGH_VELOCITY_WINDOW_MS = 30_000;
  public readonly MIN_RELEVANCE_SCORE = 0.2;

  // Reserved for future enhancements that may use the OpenAI service for richer heuristics.
  constructor(_openaiService?: OpenAIService) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether the planner can be skipped for a catchup trigger.
   * When a heuristic fires we return `skip: true` with a human-readable reason.
   */
  public async shouldSkipPlanner(
    message: Message,
    recentMessages: Message[],
    channelKey: string
  ): Promise<CatchupFilterDecision> {
    try {
      const botId = message.client.user?.id;
      const botUsername = message.client.user?.username ?? '';
      const isDirectMessage = !message.guildId;

      const combined = [...recentMessages, message].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
      );
      const evaluationWindow = combined.slice(-this.RECENT_MESSAGE_WINDOW);

      // Presence of the bot in the recent history short-circuits several heuristics.
      const mentionDetected =
        !!botId && this.containsBotMention(evaluationWindow, botId, botUsername);

      // In shared channels we only interject if someone has reached out recently.
      if (!isDirectMessage && botId && !mentionDetected) {
        logger.debug(`Catchup filter heuristic (no-mention) triggered for ${channelKey}`);
        return { skip: true, reason: 'Bot not mentioned or addressed in recent context' };
      }

      const shouldConsiderEmojiHeuristic = isDirectMessage || !mentionDetected;
      if (shouldConsiderEmojiHeuristic && this.hasEmojiOnlyStreak(evaluationWindow)) {
        logger.debug(`Catchup filter heuristic (emoji-only) triggered for ${channelKey}`);
        return { skip: true, reason: 'Recent messages are emoji-only or non-substantive' };
      }

      if (this.detectConversationPattern(evaluationWindow, botId)) {
        logger.debug(`Catchup filter heuristic (other-users conversation) triggered for ${channelKey}`);
        return { skip: true, reason: 'Detected conversation between other users' };
      }

      const velocity = this.calculateMessageVelocity(evaluationWindow);
      const velocityThreshold =
        this.HIGH_VELOCITY_THRESHOLD / (this.HIGH_VELOCITY_WINDOW_MS / 1000);
      if (velocity >= velocityThreshold) {
        logger.debug(`Catchup filter heuristic (high-velocity ${velocity.toFixed(2)} msg/s) triggered for ${channelKey}`);
        return { skip: true, reason: 'High message velocity detected' };
      }

      const relevanceScore = Math.max(
        ...evaluationWindow.map(msg => this.calculateRelevanceScore(msg.content ?? '', botUsername)),
        0
      );
      if (relevanceScore < this.MIN_RELEVANCE_SCORE) {
        logger.debug(`Catchup filter heuristic (low relevance ${relevanceScore.toFixed(2)}) triggered for ${channelKey}`);
        return { skip: true, reason: 'Low content relevance to bot' };
      }

      return { skip: false, reason: 'Content appears relevant for planner' };
    } catch (error) {
      // Fail open to keep behaviour predictable if a heuristic throws.
      logger.error(`Catchup filter failed for ${channelKey}: ${(error as Error)?.message ?? error}`);
      return { skip: false, reason: 'Filter error - allowing planner to run' };
    }
  }

  // ---------------------------------------------------------------------------
  // Heuristic helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the most recent human-authored messages are all
   * lightweight, non-substantive tokens such as emoji reactions.
   */
  private hasEmojiOnlyStreak(messages: Message[]): boolean {
    const humanMessages = messages.filter(msg => !msg.author.bot);
    const streak = humanMessages.slice(-this.EMOJI_ONLY_THRESHOLD);
    if (streak.length < this.EMOJI_ONLY_THRESHOLD) {
      return false;
    }

    return streak.every(msg => this.isEmojiOnly(msg));
  }

  /**
   * Determines if a single message contains meaningful prose or is effectively
   * an emoji/reaction acknowledgement.
   */
  private isEmojiOnly(message: Message): boolean {
    // If the message ships an attachment it likely contains meaningful content.
    if (message.attachments.size > 0) {
      return false;
    }

    const content = message.content ?? '';
    if (!content) {
      return true;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return true;
    }

    const lower = trimmed.toLowerCase();

    if (GREETING_WHITELIST.has(lower)) {
      return false;
    }

    if (NON_SUBSTANTIVE_EXPRESSIONS.has(lower)) {
      return true;
    }

    if (trimmed.length <= 3 && /^[!?.,]+$/.test(trimmed)) {
      return true;
    }

    // Collapse whitespace to evaluate pure emoji sequences.
    const squashed = trimmed.replace(/\s+/g, '');
    // eslint-disable-next-line no-misleading-character-class -- Unicode emoji sequences require combining characters.
    const emojiRegex = /^(?:[\p{Extended_Pictographic}][\u{200D}\u{FE0F}]*)+$/u;
    if (emojiRegex.test(squashed)) {
      return true;
    }

    return false;
  }

  /**
   * Scans the supplied messages for explicit mentions or plaintext references to the bot.
   */
  private containsBotMention(messages: Message[], botId: string, botUsername: string): boolean {
    const mentionRegex = new RegExp(`<@!?${botId}>`, 'i');
    const escapedUsername = botUsername ? this.escapeRegExp(botUsername) : '';
    const plaintextRegex = escapedUsername ? new RegExp(`\\b${escapedUsername}\\b`, 'i') : undefined;

    for (const msg of messages) {
      // Ignore automated actors; human intent is what matters.
      if (msg.author.bot) {
        continue;
      }

      if (msg.mentions?.users?.has(botId)) {
        return true;
      }

      if (msg.mentions?.repliedUser?.id === botId) {
        return true;
      }

      const content = msg.content ?? '';
      if (!content) {
        continue;
      }

      if (mentionRegex.test(content)) {
        return true;
      }

      if (plaintextRegex && plaintextRegex.test(content)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Identifies rapid alternation between human participants, signalling the bot should stay silent.
   */
  private detectConversationPattern(messages: Message[], botId?: string): boolean {
    const nonBotMessages = messages.filter(msg => msg.author.id !== botId);
    if (nonBotMessages.length < 4) {
      return false;
    }

    const participantCounts = new Map<string, number>();
    for (const msg of nonBotMessages) {
      if (msg.author.bot) {
        return false; // Mixed bot conversation – let the planner decide.
      }

      participantCounts.set(msg.author.id, (participantCounts.get(msg.author.id) ?? 0) + 1);
    }

    if (participantCounts.size < 2 || participantCounts.size > 3) {
      return false;
    }

    // Check for rapid alternation between participants.
    let alternations = 0;
    for (let i = 1; i < nonBotMessages.length; i += 1) {
      const previousAuthor = nonBotMessages[i - 1].author.id;
      const currentAuthor = nonBotMessages[i].author.id;
      if (previousAuthor !== currentAuthor) {
        alternations += 1;
      }
    }

    const alternationRatio = alternations / Math.max(nonBotMessages.length - 1, 1);
    if (alternationRatio < 0.6) {
      return false;
    }

    const oldest = nonBotMessages[0].createdTimestamp;
    const newest = nonBotMessages[nonBotMessages.length - 1].createdTimestamp;
    const timeSpanMs = newest - oldest;

    return timeSpanMs <= 2 * 60 * 1000; // Treat as conversation if within two minutes.
  }

  /**
   * Computes messages-per-second for human authors only so automated bursts do not skew the result.
   */
  private calculateMessageVelocity(messages: Message[]): number {
    const humanMessages = messages.filter(msg => !msg.author.bot);
    if (humanMessages.length < 2) {
      return 0;
    }

    // Evaluate the most recent human burst to determine conversational pacing.
    const sorted = [...humanMessages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const window = sorted.slice(-this.HIGH_VELOCITY_THRESHOLD);

    if (window.length < this.HIGH_VELOCITY_THRESHOLD) {
      return 0;
    }

    const durationMs = window[window.length - 1].createdTimestamp - window[0].createdTimestamp;
    if (durationMs <= 0) {
      return this.HIGH_VELOCITY_THRESHOLD;
    }

    const messagesPerSecond = window.length / (durationMs / 1000);
    return messagesPerSecond;
  }

  /**
   * Produces a coarse relevance score indicating whether the content likely warrants a bot reply.
   */
  private calculateRelevanceScore(content: string, botUsername: string): number {
    if (!content) {
      return 0;
    }

    const lower = content.toLowerCase();
    let score = 0;

    if (lower.includes('?')) {
      score += 0.4;
    }

    if (/\b(tell|show|explain|help|can|could|should|would|please|anyone|someone)\b/.test(lower)) {
      score += 0.3;
    }

    if (TECHNICAL_KEYWORDS.some(keyword => lower.includes(keyword))) {
      score += 0.2;
    }

    const trimmedLower = lower.trim();
    const mentionTokens = ['hey', 'hi', 'hello', 'ping', 'bot'];
    if (botUsername) {
      mentionTokens.push(this.escapeRegExp(botUsername));
    }
    // Treat directives and friendly openings as mild signals to respond.
    const engagementRegex = new RegExp(`^(${mentionTokens.join('|')})\\b`, 'i');
    if (engagementRegex.test(trimmedLower)) {
      score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * Escapes user-provided strings before inserting them into dynamic regular expressions.
   */
  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
