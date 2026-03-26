/**
 * @description: Re-exports the shared chat API factory from @footnote/api-client.
 * @footnote-scope: utility
 * @footnote-module: DiscordChatApi
 * @footnote-risk: medium - Chat API failures can break the bot's primary chat path.
 * @footnote-ethics: medium - Stable chat transport keeps backend reasoning and provenance visible to users.
 */
export {
    createChatApi,
    type ChatApi,
    type CreateChatApiOptions,
    type DiscordChatApiResponse,
    type UnknownChatActionResponse,
} from '@footnote/api-client';
