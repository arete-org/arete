/**
 * @description: Defines shared Discord slash command types and the command contract.
 * @footnote-scope: interface
 * @footnote-module: BaseCommand
 * @footnote-risk: low - Incorrect typing can break command registration or execution wiring.
 * @footnote-ethics: low - This module is structural and does not alter user-facing behavior.
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

