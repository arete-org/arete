/**
 * @description: Re-exports the shared profile overlay formatter for backend prompt builders.
 * @footnote-scope: utility
 * @footnote-module: BackendProfilePromptOverlay
 * @footnote-risk: medium - Wrong overlay formatting can change which identity instructions the backend sends to the image runtime.
 * @footnote-ethics: high - Overlay text directly shapes assistant identity and behavior.
 */

export {
    buildProfileOverlaySystemMessage,
    type ProfilePromptOverlayUsage,
} from '@footnote/config-spec/bot-profile';
