import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './MarkdownContent';

it('renders headings, lists, emphasis, tables and code as semantic HTML', () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      text={
        '## Capacités\n\n**Analyser**\n- Charge\n- Forme\n\n`analytics`\n\n| Jour | Séance |\n| --- | --- |\n| Lundi | Repos |\n\n```python\nprint("ok")\n```'
      }
    />
  );
  for (const token of [
    '<h2>',
    '<strong>Analyser</strong>',
    '<ul>',
    '<li>Charge</li>',
    '<table>',
    '<th>Jour</th>',
    '<code>analytics</code>',
    '<pre>',
  ])
    expect(html).toContain(token);
});
it('does not execute HTML, unsafe links or load model-supplied images', () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      text={
        '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![tracking](https://example.com/pixel)'
      }
    />
  );
  expect(html).not.toContain('<script');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('example.com/pixel');
});
it('renders partial streaming markdown without throwing', () => {
  expect(
    renderToStaticMarkup(
      <MarkdownContent text={'**Analyser\n\n- Charge\n\n```py\nprint('} />
    )
  ).toContain('Analyser');
});

it('keeps links safe and readable', () => {
  const html = renderToStaticMarkup(
    <MarkdownContent text={'[Source](https://example.com)'} />
  );
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('target="_blank"');
});
