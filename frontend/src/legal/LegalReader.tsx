import { lazy, Suspense, useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { LoadingState } from '@/components/States';
import { importChunk } from '@/lib/chunkReload';
import { cn } from '@/lib/utils';
import { LEGAL_DOCUMENTS, type LegalId } from './documents';

const LegalDocument = lazy(importChunk(() => import('./LegalDocument')));

/** Both texts, each opened in place in a scrolling box; one at a time. */
export function LegalReader() {
  const [open, setOpen] = useState<LegalId | null>(null);
  return (
    <div className="space-y-2">
      {LEGAL_DOCUMENTS.map((doc) => {
        const expanded = open === doc.id;
        return (
          <div key={doc.id}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`legal-${doc.id}`}
              onClick={() => setOpen(expanded ? null : doc.id)}
              className="w-full flex items-center gap-2 text-left text-sm font-sans text-neon-cyan hover:underline"
            >
              <FileText className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">{expanded ? `Masquer : ${doc.title}` : `Lire : ${doc.title}`}</span>
              <ChevronDown className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-180')} aria-hidden />
            </button>
            {expanded && (
              <div
                id={`legal-${doc.id}`}
                role="region"
                aria-label={doc.title}
                tabIndex={0}
                className="mt-2 max-h-[50vh] overflow-y-auto ui-inset p-4"
              >
                <Suspense fallback={<LoadingState />}>
                  <LegalDocument id={doc.id} />
                </Suspense>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
