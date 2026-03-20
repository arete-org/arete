/**
 * @description: Re-exports the shared profile overlay formatter used by Discord prompt builders.
 * @footnote-scope: utility
 * @footnote-module: ProfilePromptOverlay
 * @footnote-risk: medium - Wrong overlay formatting can weaken or duplicate the profile instructions Discord sends to runtime code.
 * @footnote-ethics: high - Overlay text directly shapes assistant identity and behavior.
 */

export {
    buildProfileOverlaySystemMessage,
    type ProfilePromptOverlayUsage,
} from '@footnote/config-spec/bot-profile';
