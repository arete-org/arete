/**
 * @description: Implements the /help command to list available bot commands.
 * @footnote-scope: interface
 * @footnote-module: HelpCommand
 * @footnote-risk: low - Failures only affect help visibility and do not impact core behavior.
 * @footnote-ethics: low - Provides informational output without sensitive processing.
 */
import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    EmbedBuilder,
    Collection,
} from 'discord.js';
import { Command } from './BaseCommand.js';

const helpCommand: Command = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show a list of available commands'),

    async execute(interaction: ChatInputCommandInteraction) {
        try {
            const commands = interaction.client.commands as Collection<
                string,
                Command
            >;

            if (!commands || commands.size === 0) {
                await interaction.reply({
                    content: '⚠️ No commands are currently available.',
                    flags: [1 << 6], // [1 << 6] = EPHEMERAL
                });
                return;
            }

            const commandList = Array.from(commands.values())
                .map((cmd) => `**/${cmd.data.name}** - ${cmd.data.description}`)
                .join('\n');

            const embed = new EmbedBuilder()
                .setTitle('📚 Available Commands')
                .setDescription(commandList || 'No commands available')
                .setColor(0x00ff00)
                .setTimestamp()
                .setFooter({ text: 'Use / before each command to use it' });

            await interaction.reply({
                embeds: [embed],
                flags: [1 << 6], // [1 << 6] = EPHEMERAL
            });
        } catch (error) {
            console.error('Error in help command:', error);
            await interaction.reply({
                content:
                    '⚠️ An error occurred while displaying the help message.',
                flags: [1 << 6], // [1 << 6] = EPHEMERAL
            });
        }
    },
};

export default helpCommand;

