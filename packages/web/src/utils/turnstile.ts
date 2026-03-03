/**
 * @description: Shares Turnstile execution and ask-input focus rules across web entry points.
 * @footnote-scope: utility
 * @footnote-module: WebTurnstileRules
 * @footnote-risk: medium - Incorrect execution guards can leave CAPTCHA stuck or create duplicate challenges.
 * @footnote-ethics: medium - Stable CAPTCHA behavior reduces unnecessary friction in public-facing access.
 */

export type AskInputFocusReason =
    | 'prompt-button'
    | 'turnstile-verify'
    | 'submit-cleanup';

export const shouldAutoFocusAskInput = (
    reason: AskInputFocusReason
): boolean => {
    return reason === 'prompt-button';
};

export type TurnstileExecutionReason = 'mount' | 'fallback' | 'submit';

export interface TurnstileExecutionState {
    isCaptchaDisabled: boolean;
    hasToken: boolean;
    hasError: boolean;
    hasWidget: boolean;
    isExecuting: boolean;
    isMounted: boolean;
}

export const shouldExecuteTurnstileChallenge = (
    reason: TurnstileExecutionReason,
    state: TurnstileExecutionState
): boolean => {
    if (
        state.isCaptchaDisabled ||
        state.hasToken ||
        state.hasError ||
        !state.hasWidget ||
        state.isExecuting
    ) {
        return false;
    }

    if (reason === 'mount') {
        return state.isMounted;
    }

    if (reason === 'fallback') {
        return !state.isMounted;
    }

    return true;
};
