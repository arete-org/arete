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
  const mins = Math.floor(secondsPerKm / 60);
  const secs = Math.round(secondsPerKm % 60);
  return `${mins}${separator}${secs.toString().padStart(2, "0")}`;
}

// A step duration in seconds → "mm:ss" ("20:00", "1:30"), "h:mm:ss" from an hour
export function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "20:00" → 1200, "1:30" → 90, "1:05:00" → 3900; a bare number is minutes ("20" → 1200). */
export function parseClock(text: string): number | null {
  const match = text.trim().match(/^(?:(?:(\d+):)?(\d+):)?(\d+)$/);
  if (!match) return null;
  const [, h, m, last] = match;
  if (m === undefined) return Number(last) > 0 ? Number(last) * 60 : null;
  if (last.length !== 2 || Number(last) >= 60) return null;
  if (h !== undefined && (m.length !== 2 || Number(m) >= 60)) return null;
  const seconds = Number(h ?? 0) * 3600 + Number(m) * 60 + Number(last);
  return seconds > 0 ? seconds : null;
}

/** "3'30", "3’30" or "3:30" (per km) → 210 seconds per km. */
export function parsePace(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2})\s*['’′:]\s*(\d{2})(?:\s*(?:min)?\/\s*km)?$/i);
  if (!match || Number(match[2]) >= 60) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds > 0 ? seconds : null;
}

/** 'API Error 422: {"detail":"Enregistrement vide"}' -> 'Enregistrement vide' */
export function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/\{.*\}/s);
  if (match) {
    try {
      const body = JSON.parse(match[0]) as { detail?: string };
      if (body.detail) return body.detail;
    } catch {
      // fall through to the raw message
    }
  }
  return raw;
}
