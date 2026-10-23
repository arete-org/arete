import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Loader2,
  Wrench,
} from 'lucide-react';
import type { Preview, ToolPart } from '@/lib/agentStream';

import { isRecovered, toolLabel } from '@/lib/agentActivity';

function ToolPreview({ label, preview }: { label: string; preview?: Preview }) {
  if (!preview?.text) return null;
  let text = preview.text;
  if (!preview.truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* Valid plain-text output. */
    }
  }
  return (
    <div className="mt-3 min-w-0">
      <p className="mb-1 text-[10px] text-text-muted">
        {label}
      </p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-void/70 p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary">
        {text}
      </pre>
      {preview.truncated && (
        <p className="mt-1 text-[10px] text-text-muted">
          Aperçu limité à 2 000 caractères.
        </p>
      )}
    </div>
  );
}

export function ToolActivity({ tools, compact = false }: { tools: ToolPart[]; compact?: boolean }) {
  const running = tools.some((t) => t.status === 'running');
  const failed = tools.some((t) => t.status === 'error' && !isRecovered(t, tools));
  return (
    <section
      aria-label="Activité des outils"
      className={compact ? "min-w-0" : "my-3 overflow-hidden rounded-xl border border-text-muted/15 bg-shadow/35"}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-text-muted">
        <Wrench className="size-3" />
        <span className="font-medium">
          {running ? 'En cours' : failed ? 'Activité · erreur' : 'Activité'}
        </span>
        <span className="ml-auto tabular-nums">
          {tools.length} {tools.length > 1 ? 'outils' : 'outil'}
        </span>
      </div>
      {tools.map((tool) => (
        <details key={tool.id} className="group border-t border-text-muted/10">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs hover:bg-text-muted/5 [&::-webkit-details-marker]:hidden">
            {tool.status === 'running' ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none text-neon-cyan" />
            ) : tool.status === 'error' ? (
              <CircleAlert className={`size-3.5 shrink-0 ${isRecovered(tool, tools) ? 'text-text-muted' : 'text-danger-red'}`} />
            ) : tool.status === 'interrupted' ? (
              <CircleStop className="size-3.5 shrink-0 text-text-muted" />
            ) : (
              <Check className="size-3.5 shrink-0 text-success-green/80" />
            )}
            <span className="min-w-0 flex-1 text-text-secondary">
              {toolLabel(tool)}
            </span>
            <span className="text-[10px] text-text-muted">
              {tool.status === 'error'
                ? isRecovered(tool, tools) ? 'Échec · repris' : 'Échec'
                : tool.status === 'interrupted'
                  ? 'Interrompu'
                  : tool.status === 'running'
                    ? 'En cours'
                    : 'Terminé'}
            </span>
            {tool.elapsed_ms !== undefined && (
              <span className="text-[10px] tabular-nums text-text-muted">
                {(tool.elapsed_ms / 1000).toFixed(1)} s
              </span>
            )}
            <ChevronRight className="size-3 shrink-0 text-text-muted transition-transform group-open:rotate-90" />
          </summary>
          <div className="px-3 pb-3">
            <code className="text-[10px] text-text-muted">{tool.name}</code>
            <ToolPreview label="Paramètres" preview={tool.args} />
            <ToolPreview
              label={tool.status === 'error' ? 'Erreur' : 'Résultat'}
              preview={tool.output}
            />
          </div>
        </details>
      ))}
    </section>
  );
}
