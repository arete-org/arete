/**
 * @description: Extends Discord.js types with bot-specific client properties.
 * @arete-scope interface
 * @arete-module DiscordTypeExtensions
 * @arete-risk: low - Type drift can break command registration or tooling.
 * @arete-ethics: low - Types do not change runtime behavior.
 */

import { Collection, Client as DiscordClient } from 'discord.js';
import { Command } from '../commands/BaseCommand';

declare module 'discord.js' {
  /**
   * Extended Discord.js Client interface with custom properties
   * @template Ready - Whether the client is ready (boolean literal type)
   */
  export interface Client<Ready extends boolean = boolean> extends DiscordClient<Ready> {
    /**
     * Collection of registered commands, mapped by command name
     */
    commands: Collection<string, Command>;
    
    /**
     * Map of event handlers, mapped by handler name
     */
    handlers: Collection<string, unknown>;
  }
}
