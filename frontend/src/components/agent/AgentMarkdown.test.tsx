// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentMarkdown } from './AgentMarkdown';

afterEach(cleanup);

it('shows the received text at once, then formats it when the renderer arrives', async () => {
  const { container } = render(<AgentMarkdown text={'**Repos** demain'} />);
  expect(container.textContent).toBe('**Repos** demain');
  expect((await screen.findByText('Repos')).tagName).toBe('STRONG');
  expect(container.textContent).toBe('Repos demain');
});

it('keeps answers readable after a failed load and formats them once a retry succeeds', async () => {
  vi.resetModules();
  const failing = { once: true };
  vi.doMock('./MarkdownContent', async (original) => {
    if (failing.once) {
      failing.once = false;
      throw new Error('Chunk indisponible');
    }
    return original();
  });
  const { AgentMarkdown: Fresh } = await import('./AgentMarkdown');
  const { preloadAgentMarkdown } = await import('./markdownRenderer');
  const { container, unmount } = render(<Fresh text={'**Repos**'} />);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(container.textContent).toBe('**Repos**');
  unmount();
  preloadAgentMarkdown(); // the next panel opening
  render(<Fresh text={'**Repos**'} />);
  expect((await screen.findByText('Repos')).tagName).toBe('STRONG');
  vi.doUnmock('./MarkdownContent');
});
