import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, FileUp, Loader2, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ACCEPTED_EXTENSIONS, importActivities, MAX_FILES, summarise, type ImportResult } from '@/lib/activityImport';

interface ActivityDropzoneProps {
  /** Every file's result, once the whole batch has been sent. */
  onImported?: (results: ImportResult[]) => void;
}

const STATUS_TEXT: Record<ImportResult['status'], string> = {
  imported: 'Importé',
  duplicate: 'Déjà dans Arete',
  error: 'Refusé',
};

/**
 * « Importer une activité » : FIT, TCX or GPX files (or a ZIP of them) from any
 * watch, dropped or picked, sent one by one with a result per file.
 */
export function ActivityDropzone({ onImported }: ActivityDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  /** The last batch in one sentence, once every file is sent. */
  const [summary, setSummary] = useState<string | null>(null);
  /** A drop refused while a batch runs; the progress keeps its own region. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const busy = progress !== null;

  const run = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (busy) {
        setRefusal('Un import est déjà en cours : dépose ces fichiers quand il sera terminé.');
        return;
      }
      setSummary(null);
      setRefusal(null);
      const all = await importActivities(files, (done, total, sofar) => {
        setProgress({ done, total });
        setResults(sofar);
      });
      setProgress(null);
      setRefusal(null);
      setSummary(summarise(all));
      onImported?.(all);
    },
    [busy, onImported]
  );
  const status =
    progress && progress.total > 0
      ? `Import ${Math.min(progress.done + 1, progress.total)} sur ${progress.total}…`
      : (summary ?? '');

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      void run(Array.from(e.dataTransfer.files));
    },
    [run]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      void run(files);
    },
    [run]
  );

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'relative border-2 border-dashed rounded-lg p-6 sm:p-8 text-center',
          'transition-all duration-200 cursor-pointer',
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-neon-cyan',
          isDragOver
            ? 'border-neon-cyan bg-neon-cyan/10 scale-[1.02]'
            : 'border-text-muted/30 hover:border-neon-cyan/50 hover:bg-abyss/50'
        )}
      >
        <input
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          multiple
          aria-label="Importer une activité"
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          disabled={busy}
        />

        <div className="flex flex-col items-center gap-3">
          {busy ? (
            <Loader2 className="w-8 h-8 text-neon-cyan animate-spin" aria-hidden />
          ) : (
            <Upload
              aria-hidden
              className={cn(
                'w-8 h-8 transition-all duration-200',
                isDragOver ? 'text-neon-cyan -translate-y-1' : 'text-text-muted'
              )}
            />
          )}

          <div>
            <span className={cn('text-sm font-sans', isDragOver ? 'text-neon-cyan' : 'text-text-secondary')}>
              {busy ? 'Import en cours…' : 'Dépose tes fichiers d’activité ici'}
            </span>
            <div className="text-xs text-text-muted mt-1 font-sans">
              ou clique pour parcourir · FIT, TCX, GPX ou ZIP, depuis n’importe quelle montre ({MAX_FILES} fichiers, 4,5 Mo par fichier, après compression si ton navigateur la permet)
            </div>
          </div>
        </div>
      </div>

      {/* Always mounted, so screen readers announce each step and the summary. */}
      <p role="status" aria-live="polite" className="text-xs font-sans text-text-muted">
        {status}
      </p>
      {refusal && (
        <p role="alert" className="text-xs font-sans text-warning-orange">
          {refusal}
        </p>
      )}
      {progress && progress.total > 0 && (
        <div className="space-y-1">
          <div
            role="progressbar"
            aria-label="Progression de l’import"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            className="h-1.5 w-full overflow-hidden rounded-full bg-text-muted/20"
          >
            <div
              className="h-full bg-neon-cyan transition-all duration-300"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {results.length > 0 && (
        <ul aria-label="Résultats de l’import" className="space-y-2">
          {results.map((result, index) => (
            <li key={`${result.filename}-${index}`} className="flex items-start gap-2 text-xs font-sans">
              <FileUp className="w-3 h-3 mt-0.5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="text-text-secondary break-all">{result.filename}</span>
                  <StatusBadge status={result.status} />
                </div>
                <p className="text-text-muted">{result.message}</p>
                {result.status === 'imported' && result.session_id && (
                  <Link to={`/log/sessions/${result.session_id}`} className="text-neon-cyan underline-offset-2 hover:underline">
                    Voir la séance
                  </Link>
                )}
                {result.status === 'duplicate' && result.duplicate_of && (
                  <Link to={`/log/sessions/${result.duplicate_of}`} className="text-neon-cyan underline-offset-2 hover:underline">
                    Voir la séance existante
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: ImportResult['status'] }) {
  const tone = status === 'imported' ? 'text-success-green' : status === 'duplicate' ? 'text-warning-orange' : 'text-danger-red';
  const Icon = status === 'imported' ? Check : status === 'duplicate' ? AlertTriangle : X;
  return (
    <span className={cn('inline-flex items-center gap-1', tone)}>
      <Icon className="w-3 h-3" aria-hidden />
      {STATUS_TEXT[status]}
    </span>
  );
}
