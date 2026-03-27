/**
 * @description: Main orchestration point controlling system initialization, authentication, and event routing.
 * @footnote-scope: core
 * @footnote-module: Main
 * @footnote-risk: high - Failure here can halt the application or expose tokens and credentials.
 * @footnote-ethics: high - Determines which modules (including cost tracking and audit systems) are initialized, affecting transparency and accountability across the bot.
 */

import { Client, GatewayIntentBits, Events, Collection } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { CommandHandler } from './utils/commandHandler.js';
import { EventManager } from './utils/eventManager.js';
import { logger } from './utils/logger.js';
import { runtimeConfig } from './config.js';
import type { Command } from './commands/BaseCommand.js';
import { ChannelContextManager } from './state/ChannelContextManager.js';
import { applyChatCommandProfileChoices } from './utils/chatCommandProfiles.js';
import { handleButtonInteraction } from './interactions/buttonHandlers.js';
import { handleModalSubmitInteraction } from './interactions/modalSubmitHandlers.js';
import { handleStringSelectMenuInteraction } from './interactions/selectMenuHandlers.js';
//import express from 'express'; // For webhook
//import bodyParser from "body-parser"; // For webhook

type ClientWithCommands = Client & {
    commands?: Map<string, Command>;
};

// NOTE: @discordjs/voice requires Node.js 22.12.0+ to support DAVE (voice E2EE).
// ====================
// Environment Setup
// ====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sharedContextManager = runtimeConfig.contextManager.enabled
    ? new ChannelContextManager({
          enabled: true,
          maxMessagesPerChannel:
              runtimeConfig.contextManager.maxMessagesPerChannel,
          messageRetentionMs: runtimeConfig.contextManager.messageRetentionMs,
          evictionIntervalMs: runtimeConfig.contextManager.evictionIntervalMs,
      })
    : null;

// Re-export modules needed by server.js
export { RateLimiter } from './utils/RateLimiter.js';

// ====================
// Client Configuration
// ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
    presence: { status: 'online' },
});

// ====================
// Initialize Managers
// ====================
const commandHandler = new CommandHandler();
const eventManager = new EventManager(client, {
    contextManager: sharedContextManager,
});

// Initialize client handlers
client.handlers = new Collection();

// VoiceStateHandler will be instantiated by EventManager (auto-registers itself to client.handlers)

// ====================
// Load and Register Commands
// ====================
// Use an async IIFE to handle top-level await
(async () => {
    try {
        // Load commands first
        const commands = await commandHandler.loadCommands();
        await applyChatCommandProfileChoices(commands);

        // Deploy commands to Discord across all configured guilds.
        // This keeps command rollout explicit and predictable for each guild.
        logger.debug('Deploying commands to Discord...');
        let successfulGuildDeployments = 0;
        let failedGuildDeployments = 0;
        for (const guildId of runtimeConfig.guildIds) {
            try {
                await commandHandler.deployCommands(
                    runtimeConfig.token,
                    runtimeConfig.clientId,
                    guildId
                );
                successfulGuildDeployments += 1;
            } catch (error) {
                failedGuildDeployments += 1;
                logger.error('Guild command deployment failed.', {
                    guildId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }

        logger.info('Guild command deployment completed.', {
            successfulGuildDeployments,
            failedGuildDeployments,
            totalGuilds: runtimeConfig.guildIds.length,
        });

        if (
            successfulGuildDeployments === 0 &&
            runtimeConfig.guildIds.length > 0
        ) {
            throw new Error(
                'All guild command deployments failed. Aborting startup.'
            );
        }

        // Store commands in memory for execution
        commands.forEach((cmd, name) => {
            const clientWithCommands = client as ClientWithCommands;
            clientWithCommands.commands =
                clientWithCommands.commands || new Map();
            clientWithCommands.commands.set(name, cmd);
            logger.debug(`Command stored in memory: ${name}`);
        });

        // Load events after commands are registered
        logger.debug('Loading events...');
        await eventManager.loadEvents(__dirname + '/events');
        eventManager.registerAll();
        logger.debug('Events loaded and registered.');

        // Login to Discord after everything is set up
        logger.debug('Logging in to Discord...');
        await client.login(runtimeConfig.token);
        logger.info('Bot is now connected to Discord and ready!');
    } catch (error) {
        logger.error('Failed to initialize bot:' + error);
        process.exit(1);
    }
})();

// ====================
// Process Handlers
// ====================
// Client ready handler
client.once(Events.ClientReady, () => {
    logger.info(`Logged in as ${client.user?.tag}`);
});

// Slash commands handler
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = (
            interaction.client as ClientWithCommands
        ).commands?.get(interaction.commandName);

        if (!command) {
            logger.error(
                `No command matching ${interaction.commandName} was found.`
            );
            return;
        }

        logger.info(`Executing command: ${interaction.commandName}`);

        try {
            await command.execute(interaction);
        } catch (error) {
            logger.error(
                `Error executing command ${interaction.commandName}: ${error}`
            );
        }

        return;
    }

    if (interaction.isStringSelectMenu()) {
        const handled = await handleStringSelectMenuInteraction(interaction);
        if (handled) {
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        const handled = await handleModalSubmitInteraction(interaction);
        if (handled) {
            return;
        }
    }

    // ====================
    // Button Interactions
    // ====================
    if (interaction.isButton()) {
        const handled = await handleButtonInteraction(interaction);
        if (handled) {
            return;
        }
    }
});

// ====================
// Handle Uncaught Exceptions
// ====================
process.on('unhandledRejection', (error: Error) => {
    logger.error(`Unhandled promise rejection: ${error}`);
});

process.on('uncaughtException', (error: Error) => {
    logger.error(`Uncaught exception: ${error}`);
    process.exit(1);
});
