/* eslint-disable no-undef */
/**
 * @description: Measures embed content height and posts debounced resize messages to a parent iframe host.
 * @footnote-scope: web
 * @footnote-module: EmbedHeight
 * @footnote-risk: medium - Incorrect height reporting can clip the embed or cause resize loops in host pages.
 * @footnote-ethics: medium - Broken embed sizing can hide provenance or error states from users on external sites.
 */

export const EMBED_HEIGHT_MESSAGE_TYPE = 'arete-embed-height';
export const EMBED_LAYOUT_CHANGE_EVENT = 'footnote:embed-layout-change';

interface EmbedHeightMessengerOptions {
    document?: Document;
    root?: HTMLElement | null;
    targetOrigin?: string;
    targetWindow?: Window | null;
}

interface EmbedLayoutChangeDetail {
    reason?: string;
}

/**
 * Measures the tallest known content source so the host iframe grows with the embed.
 */
export function measureEmbedHeight(
    root?: HTMLElement | null,
    documentRef: Document = document
): number {
    const candidates = [
        documentRef.documentElement?.scrollHeight ?? 0,
        documentRef.body?.scrollHeight ?? 0,
        documentRef.documentElement?.offsetHeight ?? 0,
        documentRef.body?.offsetHeight ?? 0,
        documentRef.documentElement?.clientHeight ?? 0,
        documentRef.body?.clientHeight ?? 0,
        root?.scrollHeight ?? 0,
        root?.offsetHeight ?? 0,
        root?.clientHeight ?? 0,
    ].filter((value) => Number.isFinite(value) && value > 0);

    return Math.ceil(Math.max(...candidates, 0));
}

/**
 * Creates a debounced messenger so multiple layout mutations within the same frame only post once.
 */
export function createEmbedHeightMessenger({
    document: documentRef = document,
    root,
    targetOrigin = '*',
    targetWindow = window.parent,
}: EmbedHeightMessengerOptions) {
    let frameId: number | null = null;
    let lastHeight: number | null = null;

    const postHeight = (): number | null => {
        if (!targetWindow || targetWindow === window) {
            return null;
        }

        const height = measureEmbedHeight(root, documentRef);
        if (height <= 0 || height === lastHeight) {
            return height;
        }

        lastHeight = height;
        targetWindow.postMessage(
            { type: EMBED_HEIGHT_MESSAGE_TYPE, height },
            targetOrigin
        );
        return height;
    };

    const schedulePostHeight = (): void => {
        if (frameId !== null) {
            return;
        }

        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            postHeight();
        });
    };

    const dispose = (): void => {
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
            frameId = null;
        }
    };

    return {
        dispose,
        postHeight,
        schedulePostHeight,
    };
}

/**
 * Lets child components nudge the embed page when state changes before observers fire.
 */
export function notifyEmbedLayoutChanged(reason?: string): void {
    window.dispatchEvent(
        new CustomEvent<EmbedLayoutChangeDetail>(EMBED_LAYOUT_CHANGE_EVENT, {
            detail: { reason },
        })
    );
}
