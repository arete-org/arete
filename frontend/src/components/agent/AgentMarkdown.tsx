import { lazy, memo, Suspense, type ComponentType } from 'react';

let renderer: Promise<typeof import('./MarkdownContent')> | undefined;
/** react-markdown and its parsers are a third of the app's code: they load with
 *  the coach, not with the dashboard. A failed load may be retried later. */
function loadRenderer() {
  renderer ??= import('./MarkdownContent').catch((error: unknown) => {
    renderer = undefined;
    throw error;
  });
  return renderer;
}

/** Called when the coach is about to open, so its first answer is already formatted. */
export function preloadAgentMarkdown() {
  loadRenderer().catch(() => {});
}

function PlainText({ text }: { text: string }) {
  return (
    <div className="coach-markdown">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

// Offline without the chunk, the answer stays readable as plain text.
const MarkdownContent = lazy<ComponentType<{ text: string }>>(() =>
  loadRenderer().then(
    (module) => ({ default: module.MarkdownContent }),
    () => ({ default: PlainText }),
  ),
);

/** Until the renderer arrives, the received text shows as is: never a blank answer. */
export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<PlainText text={text} />}>
      <MarkdownContent text={text} />
    </Suspense>
  );
});
