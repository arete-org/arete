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
