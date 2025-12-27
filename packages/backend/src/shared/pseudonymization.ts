/**
 * @arete-module: Pseudonymization
 * @arete-risk: moderate
 * @arete-ethics: high
 * @arete-scope: utility
 *
 * @description: Utilities for namespacing and hashing Discord identifiers with HMAC-SHA256.
 * The goal is to avoid ever storing or logging raw IDs while still preserving
 * uniqueness for audit and deduplication. Always store the full 64-hex digest
 * for maximum entropy, and expose only short prefixes (10-12 chars) in logs or
 * admin surfaces.
 *
 * @impact
 * Risk: Hashing mistakes can lead to data loss or mismatched audits.
 * Ethics: Prevents accidental storage or logging of raw user identifiers.
 */

import crypto from 'crypto';
import type { IncidentPointers } from './sqliteIncidentStore';

const HEX_DIGEST_LENGTH = 64;
const DEFAULT_SHORT_LENGTH = 12;
const HEX_64_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Hash an identifier with HMAC-SHA256, namespacing by ID type to avoid
 * cross-domain collisions (e.g., user vs guild IDs).
 */
export function hmacId(secret: string, id: string, namespace: string): string {
  if (!secret || secret.trim().length === 0) {
    throw new Error('Pseudonymization secret must be provided.');
  }
  const normalized = String(id);
  // Prefix the ID with its type so guild "123" and user "123" hash differently.
  const input = `${namespace}:${normalized}`;
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

/**
 * Present a shortened hash for operator-facing logs or admin views while
 * keeping the full digest in storage.
 */
export function shortHash(hash: string, length: number = DEFAULT_SHORT_LENGTH): string {
  if (!hash) return '';
  // Clamp so we always return a short, usable prefix.
  return hash.slice(0, Math.max(1, Math.min(length, HEX_DIGEST_LENGTH)));
}

/**
 * Idempotently pseudonymize an actor identifier. If it already looks like a
 * 64-hex digest, return as-is to avoid double hashing.
 */
export function pseudonymizeActorId(
  actorId: string | null | undefined,
  secret: string
): string | null {
  if (!actorId) {
    return null;
  }
  const trimmed = actorId.trim();
  // Already hashed? Leave it alone so we don't hash twice.
  if (HEX_64_REGEX.test(trimmed)) {
    return trimmed;
  }
  return hmacId(secret, trimmed, 'user');
}

/**
 * Pseudonymize incident pointers that reference Discord resources. Non-ID
 * fields are preserved as-is.
 */
export function pseudonymizeIncidentPointers(
  pointers: IncidentPointers,
  secret: string
): IncidentPointers {
  // Copy first so we never mutate the caller's object.
  const clone: IncidentPointers = { ...pointers };

  const maybeHash = (key: keyof IncidentPointers, namespace: string) => {
    const value = clone[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      const trimmed = value.trim();
      if (!HEX_64_REGEX.test(trimmed)) {
        clone[key] = hmacId(secret, trimmed, namespace);
      }
    }
  };

  // Hash Discord IDs only; URLs and trace metadata stay as-is.
  maybeHash('guildId', 'guild');
  maybeHash('channelId', 'channel');
  maybeHash('messageId', 'message');

  return clone;
}
