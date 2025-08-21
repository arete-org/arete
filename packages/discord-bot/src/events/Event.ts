/**
 * @file Event.ts
 * @description Base event class for Discord.js events with robust error handling and registration.
 * This provides a foundation for all Discord.js event handlers in the application.
 */

import { Client, ClientEvents } from 'discord.js';
import { logger } from '../utils/Logger.js';

/**
 * Abstract base class for Discord.js event handlers.
 * Provides consistent error handling and event registration.
 * @abstract
 * @class Event
 */
export abstract class Event {
  /** The name of the Discord.js event to listen for */
  public readonly name: keyof ClientEvents;
  
  /** Whether the event should only be handled once */
  public readonly once: boolean;

  /**
   * Creates an instance of Event.
   * @param {Object} options - Configuration options for the event
   * @param {keyof ClientEvents} options.name - The name of the Discord.js event
   * @param {boolean} [options.once=false] - If true, the event will only be handled once
   */
  constructor(options: { name: keyof ClientEvents; once?: boolean }) {
    this.name = options.name;
    this.once = options.once ?? false;
  }

  /**
   * Main execution method to be implemented by subclasses.
   * This method contains the logic to execute when the event is emitted.
   * @abstract
   * @param {...any[]} args - Arguments passed by the Discord.js client
   * @returns {Promise<void> | void}
   */
  public abstract execute(...args: any[]): Promise<void> | void;

  /**
   * Registers the event with the Discord.js client.
   * @param {Client} client - The Discord.js client instance
   */
  public register(client: Client): void {
    try {
      if (this.once) {
        client.once(this.name, this._execute.bind(this));
      } else {
        client.on(this.name, this._execute.bind(this));
      }
      logger.debug(`Registered event: ${this.name} (${this.once ? 'once' : 'on'})`);
    } catch (error) {
      logger.error(`Failed to register event ${this.name}:`, error);
      throw error;
    }
  }

  /**
   * Wraps the execute method with error handling.
   * @private
   * @param {...any[]} args - Arguments passed by the Discord.js client
   */
  private async _execute(...args: any[]): Promise<void> {
    try {
      await this.execute(...args);
    } catch (error) {
      logger.error(`Error in event ${this.name}:`, error);
      // Optionally handle the error or rethrow
      throw error;
    }
  }
}
