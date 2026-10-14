import { authFetch } from './auth';
import { ApiError } from './api';
import type { SyncResult } from '@/types';

export interface SyncOptions {
  start_date?: string;
  end_date?: string;
  download_fit?: boolean;
  max_activities?: number;
  full_history?: boolean;
}

interface SyncBatchOptions extends Omit<SyncOptions, 'full_history'> {
  history_offset?: number;
  history_anchor?: number;
}

const STAGES = ['preparing', 'fetching', 'processing', 'fit', 'saving', 'finalizing'] as const;
export interface SyncProgress {
  stage: typeof STAGES[number];
  completed: number;
  total: number | null;
  activity_name: string | null;
  full_history?: boolean;
}

type SyncEvent =
  | ({ type: 'progress' } & SyncProgress)
  | ({ type: 'done' } & SyncResult)
  | { type: 'error'; detail: string };

const MAX_ACTIVITIES = 200;
const MAX_EVENTS = MAX_ACTIVITIES * 3 + 10;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_READS = MAX_BYTES;
const SYNC_TIMEOUT_MS = 20 * 60 * 1000;
const HISTORY_BATCH_SIZE = 20;
const MAX_HISTORY_ACTIVITIES = 20_000;
// One extra empty page proves completion when the archive ends on a full batch.
const MAX_HISTORY_BATCHES = MAX_HISTORY_ACTIVITIES / HISTORY_BATCH_SIZE + 1;
const HISTORY_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const INTERRUPTED = 'Suivi interrompu. Des activités peuvent déjà avoir été importées. Vérifie le résultat avant de relancer.';

function parseEvent(data: string): SyncEvent {
  const event = JSON.parse(data) as Record<string, unknown> | null;
  const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_ACTIVITIES;
  if (event?.type === 'error' && typeof event.detail === 'string') return event as SyncEvent;
  if (event?.type === 'progress'
    && STAGES.includes(event.stage as SyncProgress['stage'])
    && count(event.completed)
    && (event.total === null || (count(event.total) && Number(event.completed) <= Number(event.total)))
    && (event.activity_name === null || typeof event.activity_name === 'string')) return event as SyncEvent;
  if (event?.type === 'done'
    && typeof event.success === 'boolean'
    && ['activities_synced', 'activities_merged', 'activities_matched', 'activities_skipped'].every(key => count(event[key]))
    && Array.isArray(event.errors) && event.errors.every(error => typeof error === 'string')
    && (event.last_activity_date === null || typeof event.last_activity_date === 'string')) return event as SyncEvent;
  throw new Error('Progression Garmin invalide.');
}

/** The terminal result is mandatory: a closed connection is never a successful sync. */
export async function consumeGarminSync(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let events = 0;
  try {
    for (let reads = 0; reads < MAX_READS; reads++) {
      const { done, value } = await reader.read();
      if (done) throw new Error(INTERRUPTED);
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Réponse Garmin trop volumineuse.');
      buffer += decoder.decode(value, { stream: true });
      for (let frames = 0; frames <= MAX_EVENTS; frames++) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (++events > MAX_EVENTS) throw new Error('Trop d’événements Garmin.');
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = parseEvent(data);
        if (event.type === 'error') throw new Error(event.detail);
        if (event.type === 'done') return event;
        onProgress(event);
      }
    }
    throw new Error('Limite de lecture Garmin atteinte.');
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

export async function streamGarminSync(
  options: SyncOptions,
  onProgress: (progress: SyncProgress) => void,
  signal: AbortSignal,
): Promise<SyncResult> {
  const { full_history, ...batchOptions } = options;
  if (!full_history) return streamBatch(batchOptions, onProgress, signal);

  const historySignal = AbortSignal.any([signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)]);
  const aggregate: SyncResult = { success: true, activities_synced: 0, activities_merged: 0, activities_matched: 0, activities_skipped: 0, errors: [], last_activity_date: null };
  let offset = 0;
  let anchor: number | undefined;
  for (let batch = 0; batch < MAX_HISTORY_BATCHES; batch++) {
    if (historySignal.aborted) throw new Error(INTERRUPTED);
    let completed = 0;
    const result = await streamBatch({
      download_fit: options.download_fit,
      max_activities: HISTORY_BATCH_SIZE,
      history_offset: offset,
      ...(anchor === undefined ? {} : { history_anchor: anchor }),
    }, progress => {
      completed = Math.max(completed, progress.completed);
      onProgress({ ...progress, full_history: true, completed: offset + completed, total: null });
    }, historySignal);
    aggregate.success = result.success;
    aggregate.activities_synced += result.activities_synced;
    aggregate.activities_merged += result.activities_merged;
    aggregate.activities_matched += result.activities_matched;
    aggregate.activities_skipped += result.activities_skipped;
    aggregate.errors.push(...result.errors);
    aggregate.last_activity_date = result.last_activity_date ?? aggregate.last_activity_date;
    if (!result.success) return aggregate;
    // Both fields must be explicit: an old server cannot silently stop after page one.
    if (result.next_history_offset === null && result.history_anchor === null) return aggregate;
    if (result.next_history_offset !== offset + HISTORY_BATCH_SIZE
      || result.next_history_offset > MAX_HISTORY_ACTIVITIES
      || !Number.isSafeInteger(result.history_anchor) || Number(result.history_anchor) <= 0) {
      throw new Error('Suite de l’historique Garmin invalide. Import incomplet.');
    }
    offset = result.next_history_offset;
    anchor = Number(result.history_anchor);
  }
  throw new Error('Limite de 20 000 activités atteinte ; import incomplet.');
}

async function streamBatch(
  options: SyncBatchOptions,
  onProgress: (progress: SyncProgress) => void,
  signal: AbortSignal,
): Promise<SyncResult> {
  try {
    const response = await authFetch('/api/garmin/sync/activities/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      signal: AbortSignal.any([signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      const error = new ApiError(response.status, await response.text());
      throw new Error(error.detail || error.message);
    }
    if (!response.body) throw new Error(INTERRUPTED);
    return await consumeGarminSync(response.body, onProgress);
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) {
      throw new Error(INTERRUPTED, { cause: error });
    }
    throw error;
  }
}
