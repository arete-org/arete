/**
 * @arete-module: CommandHandler
 * @arete-risk: high
 * @arete-ethics: moderate
 * @arete-scope: core
 *
 * @description: Manages Discord slash command deployment and registration.
 *
 * @impact
 * Risk: Handles command discovery, validation, and API registration. Failures can prevent users from accessing bot features or cause command registration errors.
 * Ethics: Controls which commands are available to users, affecting the bot's capabilities and user interaction surface.
 */

import { REST, Routes, Collection } from 'discord.js';
import { Command } from '../commands/BaseCommand.js';
import path from 'path';
import { readdir } from 'fs/promises';
import { logger } from './logger.js';


/**
 * Handles loading and managing Discord slash commands.
 * Responsible for discovering, validating, and registering commands with Discord's API.
 * @class CommandHandler
 */
export class CommandHandler {
  /** Collection of loaded commands, mapped by command name */
  private commands = new Collection<string, Command>();

  /**
   * Loads all command files from the commands directory.
   * @async
   * @returns {Promise<Collection<string, Command>>}
   * @throws {Error} If there's an error loading commands
   */
  async loadCommands(): Promise<Collection<string, Command>> {
    try {
      logger.debug('Loading commands...');

      // In development, we need to look in the src directory for .ts files
      const isDev = process.env.NODE_ENV !== 'production';
      // In production, commands are in dist/commands
      const basePath = isDev 
        ? path.join(process.cwd(), 'src/commands')
        : path.join(process.cwd(), 'dist/commands');
      
      logger.debug(`Loading commands from: ${basePath}`);
      
      /**
       * Filters and loads command files based on environment
       * @type {string[]}
       */
      const commandFiles: string[] = (await readdir(basePath))
        .filter(file => {
          // In development, look for .ts files, in production look for .js files
          const isCorrectExtension = isDev ? file.endsWith('.ts') : file.endsWith('.js');
          const isNotDeclaration = !file.endsWith('.d.ts');
          const isNotBaseCommand = !file.includes('BaseCommand');
          return isCorrectExtension && isNotDeclaration && isNotBaseCommand;
        });

      logger.debug(`Found ${commandFiles.length} command files in ${basePath}`);

      for (const file of commandFiles) {
        try {
          const filePath = path.join(basePath, file);
          logger.debug(`Attempting to load command from: ${filePath}`);
          
          // Use dynamic import with file:// URL for Windows compatibility
          const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
          const { default: command } = await import(fileUrl.href);
          
          if (command?.data) {
            this.commands.set(command.data.name, command);
            logger.debug(`Loaded command: ${command.data.name}`);
          } else {
            logger.warn(`Command in ${file} is missing required 'data' property`);
          }
        } catch (error) {
          logger.error(`Error loading command ${file}:`, error);
        }
      }

      logger.info(`Successfully loaded ${this.commands.size} commands.`);
      return this.commands;
    } catch (error) {
      logger.error('Failed to load commands:', error);
      throw error;
    }
  }

  /**
   * Retrieves a command by name
   * @param {string} name - Command name
   * @returns {Command|undefined} Command instance or undefined if not found
   */
  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /**
   * Retrieves all loaded commands
   * @returns {Collection<string, Command>} Collection of commands
   */
  getAllCommands(): Collection<string, Command> {
    return this.commands;
  }

  /**
   * Registers all commands with Discord's API
   * @async
   * @param {string} token - Discord bot token
   * @param {string} clientId - Discord client ID
   * @param {string} [guildId] - Optional guild ID for guild-specific commands
   * @returns {Promise<void>}
   * @throws {Error} If registration fails
   */
  async deployCommands(token: string, clientId: string, guildId?: string): Promise<void> {
    try {
      if (this.commands.size === 0) {
        logger.debug('No commands found in cache, loading commands...');
        await this.loadCommands();
      }

      const rest = new REST({ version: '10' }).setToken(token);
      const commands = Array.from(this.commands.values()).map(cmd => {
        const commandData = cmd.data.toJSON();
        logger.debug(`Registering command: ${commandData.name}`);
        return commandData;
      });

      logger.debug(`Starting to refresh ${guildId ? 'guild' : 'application'} commands...`);
      logger.debug(`Number of commands to register: ${commands.length}`);

      if (guildId) {
        // Guild-specific commands
        logger.debug(`Registering commands for guild: ${guildId}`);
        const data = await rest.put(
          Routes.applicationGuildCommands(clientId, guildId),
          { body: commands }
        ) as unknown[];
        logger.info(`Successfully reloaded ${data.length} guild commands.`);
      } else {
        // Global commands
        logger.debug('Registering global commands');
        const data = await rest.put(
          Routes.applicationCommands(clientId),
          { body: commands }
        ) as unknown[];
        logger.info(`Successfully reloaded ${data.length} global commands.`);
      }
    } catch (error) {
      logger.error('Failed to register commands:', error);
      throw error;
    }
  }
}
