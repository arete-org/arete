import { memo, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Panel } from '@/components/ui/Panel';
import type { ChartCardData } from '@/lib/chartCards';

function subscribeTheme(update: () => void) {
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const currentTheme = () => document.documentElement.dataset.theme ?? '';
const serverTheme = () => '';
type ChartDocument = { html: string; error?: never } | { html?: never; error: string };

export const ChartCard = memo(function ChartCard({ chart }: { chart: ChartCardData }) {
  const summaryId = useId();
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, serverTheme);
  const [document, setDocument] = useState<ChartDocument | null>(null);
  useEffect(() => {
    let active = true;
    import('@/lib/chartDocument')
      .then(({ buildChartDocument }) => {
        const html = buildChartDocument(chart.html);
        if (active) setDocument({ html });
      })
      .catch((error: unknown) => {
        console.warn('Affichage du graphique impossible.', error);
        if (active) setDocument({ error: 'Graphique indisponible. Le résumé reste accessible.' });
      });
    return () => { active = false; };
  }, [chart.html, theme]);
  return (
    <figure className="my-3 min-w-0 font-sans" aria-label={chart.title} aria-describedby={summaryId}>
      <Panel title={chart.title} titleTone="text-text-primary" animate={false} className="min-w-0 overflow-hidden">
        {document?.html ? <iframe
          title={chart.title}
          srcDoc={document.html}
          sandbox=""
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height: chart.height_px }}
        /> : <p role={document?.error ? 'alert' : 'status'} className="text-xs text-text-secondary">
          {document?.error ?? 'Préparation du graphique…'}
        </p>}
        <p id={summaryId} className="mt-2 text-xs leading-relaxed text-text-secondary">{chart.summary}</p>
      </Panel>
    </figure>
  );
});
