// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentMarkdown } from './AgentMarkdown';

afterEach(cleanup);

it('shows the received text at once, then formats it when the renderer arrives', async () => {
  const { container } = render(<AgentMarkdown text={'**Repos** demain'} />);
  expect(container.textContent).toBe('**Repos** demain');
  expect((await screen.findByText('Repos')).tagName).toBe('STRONG');
  expect(container.textContent).toBe('Repos demain');
});
