import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import { documentsApi, type CoachDocument } from '@/lib/documents';
import { DocumentPreview } from './DocumentPreview';

export function MessageAttachments({
  ids,
  threadId,
}: {
  ids: string[];
  threadId: string;
}) {
  const docs = useQuery({
    queryKey: ['coach-documents', threadId],
    queryFn: () => documentsApi.list(threadId),
    retry: false,
  });
  const [selected, setSelected] = useState<CoachDocument | null>(null);
  return (
    <span className="ml-2 inline-flex max-w-full align-middle gap-2">
      {ids.map((id) => {
        const doc = docs.data?.find((d) => d.id === id);
        return (
          <button
            key={id}
            disabled={!doc || doc.status !== 'ready'}
            onClick={() => doc && setSelected(doc)}
            className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-text-secondary hover:text-text-primary hover:underline"
          >
            <Paperclip size={14} className="shrink-0" />
            <span className="truncate">
              {doc?.name ??
                (docs.isPending
                  ? 'Chargement du fichier…'
                  : 'Document indisponible')}
            </span>
          </button>
        );
      })}
      {selected && (
        <DocumentPreview
          threadId={threadId}
          document={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </span>
  );
}
