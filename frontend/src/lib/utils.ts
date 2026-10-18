import { clsx, type ClassValue } from "clsx";
import type { ZoneKind } from "./fr";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export type ZoneColor = "green" | "orange" | "red" | "cyan";

const ZONE_COLOR: Record<ZoneKind, Record<string, ZoneColor>> = {
  acwr: { undertrained: "cyan", optimal: "green", caution: "orange", danger: "red" },
  form: { freshest: "cyan", fresh: "green", neutral: "green", tired: "orange", exhausted: "red" },
  readiness: { optimal: "green", good: "green", moderate: "orange", low: "red", critical: "red" },
  monotony: { ideal: "green", acceptable: "orange", high: "red" },
  strain: { low: "cyan", optimal: "green", high: "orange", critical: "red" },
};

// Zone color mapping; unknown or missing zones stay neutral cyan.
export function getZoneColor(kind: ZoneKind, zone?: string | null): ZoneColor {
  return (zone && ZONE_COLOR[kind][zone]) || "cyan";
}

// Format duration from seconds to human readable ("1h 5m", "12m 30s")
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

// Compact duration for dense lists ("1h05", "45min", "—")
export function formatDurationCompact(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}` : `${m}min`;
}

// Pace in seconds per km → "m:ss" (or "m'ss" with separator "'")
export function formatPace(secondsPerKm: number, separator = ":"): string {
  // Round the whole pace first: 239.5 is 4:00, never 3:60.
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}${separator}${(total % 60).toString().padStart(2, "0")}`;
}

/** What an HTTP status means for the athlete, when the server gave no French detail. */
function statusText(status: number): string {
  if (status === 401 || status === 403) return 'Accès refusé : reconnecte-toi puis réessaie.';
  if (status === 404) return 'Élément introuvable : il a peut-être été supprimé.';
  if (status === 409) return 'Les données ont changé entre-temps : recharge puis réessaie.';
  if (status === 413) return 'Fichier trop volumineux.';
  if (status === 422 || status === 400) return 'Demande refusée par le serveur : vérifie les champs.';
  if (status === 429) return 'Trop de demandes : réessaie dans un instant.';
  if (status >= 500) return 'Le serveur ne répond pas correctement : réessaie dans un instant.';
  return `Erreur du serveur (code ${status}).`;
}

/** The browser's own wording for a request that never reached the server. */
const NETWORK = /failed to fetch|load failed|networkerror|network request failed|err_internet_disconnected/i;

/** A request that never got an answer (offline, DNS, connection reset), as opposed to an HTTP error. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && NETWORK.test(error.message);
}

/** Accents or common French words: the server's and the app's own messages, not a library's. */
const FRENCH = /[àâäçéèêëîïôöùûüÿœæ’]|\b(?:le|la|les|de|des|du|un|une|est|pas|pour|avec|dans|sur|cette|ton|ta|tes|aux|au|ne|et|ou|plus|trop|vide|aucune?|introuvable|impossible|invalide|inconnue?|requise?|connexion|bilan|objectif)\b/i;

/** Words a library, the browser or an untranslated server message would use. */
const ENGLISH = /\b(?:the|an?|not|no|is|are|was|be|must|cannot|can't|could|failed|failure|error|of|to|for|with|found|invalid|unexpected|undefined|null|too|large|unknown|missing|required|reading|properties|already|exists|returned|configured|connected|file|over|chars)\b/i;

/** Text fit for the athlete: French, or at least nothing that reads as English. */
export function looksFrench(text: string): boolean {
  return FRENCH.test(text) || !ENGLISH.test(text);
}

const UNEXPECTED = 'Une erreur inattendue est survenue : réessaie.';

/** A FastAPI `detail`: a string, or the validation list whose messages may be French (« Fuseau horaire inconnu. »). */
function detailText(detail: unknown): string | null {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return null;
  // Each message on its own: an English one next to a French one is dropped, not mixed in.
  const messages = detail
    .map((item) => (item && typeof item === 'object' ? (item as { msg?: unknown }).msg : null))
    .filter((msg): msg is string => typeof msg === 'string')
    .map((msg) => msg.replace(/^Value error, /, ''))
    .filter(looksFrench);
  return messages.join(' ') || null;
}

/**
 * French text for any failure, never the raw technical message: the server's
 * `detail` when it is French ('API Error 422: {"detail":"Enregistrement vide"}'
 * -> 'Enregistrement vide'), else a sentence for its status, the network, a
 * timeout or an unreadable answer. The app's own (French) messages pass
 * through; anything else becomes a generic sentence. The raw error stays in
 * the console for debugging.
 */
const logged = new WeakSet<object>();

export function readableError(error: unknown): string {
  // Once per error: render paths call this on every render.
  if (error && typeof error === 'object' && !logged.has(error)) {
    logged.add(error);
    console.debug('[readableError]', error);
  }
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return error.name === 'TimeoutError' ? 'Le serveur met trop de temps à répondre : réessaie.' : 'Demande annulée.';
  }
  if (isNetworkError(error)) return 'Connexion impossible : vérifie ton réseau puis réessaie.';
  if (error instanceof SyntaxError) return 'Réponse du serveur illisible : réessaie.';
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const status = raw.match(/^API Error (\d{3})/);
  const match = raw.match(/\{.*\}/s);
  if (match) {
    try {
      const detail = detailText((JSON.parse(match[0]) as { detail?: unknown }).detail);
      if (detail && looksFrench(detail)) return detail;
    } catch {
      // fall through to the status
    }
  }
  if (status) return statusText(Number(status[1]));
  if (raw.trim() && looksFrench(raw)) return raw;
  return UNEXPECTED;
}
