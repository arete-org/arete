/**
 * @description: Implements the lightweight ping slash command used to verify bot responsiveness.
 * @footnote-scope: interface
 * @footnote-module: PingCommand
 * @footnote-risk: low - A broken ping command only affects health-check style interactions.
 * @footnote-ethics: low - This command replies with a fixed string and does not process sensitive content.
 */

import { SlashCommandBuilder } from 'discord.js';
import { Command } from './BaseCommand.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong!'),

    async execute(interaction) {
        await interaction.reply('Pong!');
    },
};

export default command;
