import { createElement, memo, useEffect } from 'react';
import { preloadAgentMarkdown, useMarkdownRenderer } from './markdownRenderer';

function PlainText({ text }: { text: string }) {
  return (
    <div className="coach-markdown">
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}

/** Until the renderer arrives, the received text shows as is: never a blank answer. */
export const AgentMarkdown = memo(function AgentMarkdown({ text }: { text: string }) {
  const renderer = useMarkdownRenderer();
  useEffect(() => {
    if (!renderer) preloadAgentMarkdown();
  }, [renderer]);
  return renderer ? createElement(renderer, { text }) : <PlainText text={text} />;
});
