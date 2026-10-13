import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MARKDOWN_PLUGINS = [remarkGfm];

/** No raw HTML or remote images: model text is content, never executable markup. */
export const MarkdownContent = memo(function MarkdownContent({
  text,
}: {
  text: string;
}) {
  return (
    <div className="coach-markdown">
      <Markdown
        remarkPlugins={MARKDOWN_PLUGINS}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="coach-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
