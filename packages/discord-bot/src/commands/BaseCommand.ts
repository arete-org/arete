/**
 * @description: Defines shared Discord slash command types and the command contract.
 * @arete-scope: interface
 * @arete-module: BaseCommand
 * @arete-risk: low - Incorrect typing can break command registration or execution wiring.
 * @arete-ethics: low - This module is structural and does not alter user-facing behavior.
 */
import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

export type SlashCommand =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

export interface Command {
    data: SlashCommand;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}
