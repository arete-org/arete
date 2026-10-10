import { authFetch } from './auth';

export interface SourceBlock {
  locator: string;
  text: string;
  method: 'text' | 'ocr' | 'cell';
  confidence?: number | null;
  box?: number[] | null;
}
export interface Extraction { blocks: SourceBlock[]; warnings: string[] }
export interface CoachDocument { id: string; name: string; size: number; sha256: string; status: 'uploading' | 'ready' }
export interface Target { kind: 'pace_sec_km' | 'heart_rate_bpm' | 'power_w' | 'cadence_rpm' | 'hr_zone'; low: number; high: number }
export interface WorkoutStep {
  kind: 'warmup' | 'effort' | 'recovery' | 'cooldown' | 'rest' | 'repeat';
  duration_kind: 'seconds' | 'meters' | 'reps' | 'lap';
  value?: number | null;
  target?: Target | null;
  secondary_target?: Target | null;
  repeat?: number | null;
  steps: WorkoutStep[];
  exercise?: string;
  garmin_exercise?: string;
  weight_kg?: number | null;
  stroke?: 'free' | 'back' | 'breast' | 'butterfly' | 'mixed' | null;
  notes?: string;
}
export interface Prescription { version: 1; steps: WorkoutStep[]; pool_length_m?: number | null }
export interface Provenance { document_id: string; locator: string; quote: string }
export interface GarminExport { operation_id?: string; updated_at?: string; phase?: string; session_id: number; state: string; error: string | null; deleted: boolean; workout_id: number | null; schedule_id: number | null }
export interface GarminDevice { id: number; name: string; sports: string[]; compatibility: string; documentation: string | null }

export const CHUNK_BYTES = 3 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_FILES = '.xlsx,.xls,.csv,.md,.txt,.pdf,.png,.jpg,.jpeg,.webp';

export async function documentRequest<T>(path: string, init: RequestInit = {}, timeout = 30_000): Promise<T> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const response = await authFetch(`/api${path}`, { ...init, signal, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try { detail = JSON.parse(text).detail ?? text; } catch { /* A proxy may return plain text. */ }
    throw new Error(typeof detail === 'string' ? detail : 'Données invalides. Vérifie les champs.');
  }
  return response.json();
}
const root = (thread: string) => `/agent/threads/${encodeURIComponent(thread)}`;
export const documentsApi = {
  list: (thread: string) => documentRequest<CoachDocument[]>(`${root(thread)}/documents`),
  delete: (thread: string, id: string) => documentRequest(`${root(thread)}/documents/${id}`, { method: 'DELETE' }),
  deleteThread: (thread: string) => documentRequest(`${root(thread)}`, { method: 'DELETE' }),
  extraction: (thread: string, id: string, signal?: AbortSignal) => documentRequest<Extraction>(`${root(thread)}/documents/${id}/extraction`, { signal }),
};

export async function uploadDocument(thread: string, file: File, signal: AbortSignal, progress: (message: string) => void): Promise<CoachDocument> {
  const suffix = `.${file.name.split('.').pop()?.toLowerCase()}`;
  if (!ACCEPTED_FILES.split(',').includes(suffix)) throw new Error('Format non pris en charge.');
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Maximum 20 Mio par fichier, fichier vide refusé.');
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const doc = await documentRequest<CoachDocument>(`${root(thread)}/documents`, { method: 'POST', signal, body: JSON.stringify({ name: file.name, size: file.size, sha256 }) });
  // Keep an interrupted upload visible so the athlete can delete it explicitly.
  for (let position = 0; position < Math.ceil(file.size / CHUNK_BYTES); position++) {
    signal.throwIfAborted();
    progress(`Envoi ${Math.round(position * CHUNK_BYTES / file.size * 100)} %`);
    await documentRequest(`${root(thread)}/documents/${doc.id}/chunks/${position}`, { method: 'PUT', signal, headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(position * CHUNK_BYTES, (position + 1) * CHUNK_BYTES) }, 60_000);
  }
  let extraction: Extraction | null = null;
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(suffix)) {
    const { extractDocument } = await import('./documentExtraction');
    extraction = await extractDocument(file, signal, progress);
  }
  progress(suffix === '.pdf' ? 'Lecture du PDF et reconnaissance de texte…' : 'Vérification et conservation…');
  return documentRequest<CoachDocument>(`${root(thread)}/documents/${doc.id}/finalize`, { method: 'POST', signal, body: JSON.stringify(extraction) }, suffix === '.pdf' ? 270_000 : 120_000);
}

export async function originalDocument(thread: string, doc: CoachDocument, signal?: AbortSignal): Promise<Blob> {
  if (!doc.size || doc.size > MAX_FILE_BYTES) throw new Error('Taille de document invalide.');
  const parts: ArrayBuffer[] = [];
  for (let position = 0; position < Math.ceil(doc.size / CHUNK_BYTES); position++) {
    const response = await authFetch(`/api${root(thread)}/documents/${doc.id}/chunks/${position}`, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Téléchargement impossible.');
    parts.push(await response.arrayBuffer());
  }
  const suffix = doc.name.split('.').pop()?.toLowerCase() ?? '';
  const types: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  const blob = new Blob(parts, { type: types[suffix] ?? 'application/octet-stream' });
  if (blob.size !== doc.size) throw new Error('Taille du fichier téléchargé incorrecte.');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') !== doc.sha256) throw new Error('Empreinte du fichier téléchargé incorrecte.');
  signal?.throwIfAborted();
  return blob;
}

export async function downloadDocument(thread: string, doc: CoachDocument): Promise<void> {
  const blob = await originalDocument(thread, doc);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = doc.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const exportApi = {
  devices: () => documentRequest<GarminDevice[]>('/garmin/workout-devices'),
  statuses: () => documentRequest<GarminExport[]>('/garmin/exports'),
  export: (id: number, device_id: number | null) => documentRequest<GarminExport>(`/garmin/planned/${id}/export`, { method: 'POST', body: JSON.stringify({ device_id }) }, 150_000),
  reconcile: (id: number) => documentRequest<GarminExport>(`/garmin/exports/${id}/reconcile`, { method: 'POST' }, 150_000),
  remove: (id: number) => documentRequest<GarminExport>(`/garmin/exports/${id}/remove`, { method: 'POST' }, 150_000),
  update: (id: number, revision: number, date: string, description: string, prescription: Prescription) => documentRequest(`/garmin/planned/${id}/prescription`, { method: 'PUT', body: JSON.stringify({ revision, date, description, prescription }) }),
};
