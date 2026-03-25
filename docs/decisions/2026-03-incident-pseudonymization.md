# Incident Identifier Pseudonymization

**Decision:** Persist incident-facing Discord identifiers as namespaced HMAC-SHA256 digests rather than raw IDs or plain hashes.  
**Date:** 2026-03-13

---

## 1. Context

Incident reporting needs durable records and audit history, but raw Discord identifiers create unnecessary privacy risk.

We still need stable identifiers for:

- deduplication,
- incident-to-audit linkage,
- operator review,
- cross-event correlation.

Plain hashing is weaker than necessary because low-entropy identifier spaces can be brute-forced more easily. Storing raw identifiers is not acceptable for this feature.

---

## 2. Decision

We will pseudonymize Discord identifiers with namespaced HMAC-SHA256 before persistence.

The namespace is part of the input so the same numeric value in different domains does not collide across:

- user,
- guild,
- channel,
- message.

We will store the full hex digest in durable storage.

We may expose only a short prefix of that digest in operator-facing logs or internal views.

---

## 3. Scope

The following values must be pseudonymized before incident persistence:

- reporter or actor ID,
- guild ID,
- channel ID,
- message ID.

The following values may remain cleartext when needed for debugging or linking:

- response ID,
- chain hash,
- model version,
- jump URL.

These fields are not Discord identifiers and serve different operational purposes.

---

## 4. Consequences

Positive consequences:

- durable incident storage avoids raw Discord identifiers,
- audit rows remain correlatable,
- logs can use short digests without exposing source identifiers.

Tradeoffs:

- operators cannot directly recover a Discord ID from stored incident rows,
- pseudonymization secret management becomes required configuration,
- cross-environment correlation is intentionally broken when secrets differ.

---

## 5. Operational Notes

- The pseudonymization secret must be configured before incident persistence is used.
- Already-hashed 64-character digests should be treated as idempotent inputs and not hashed again.
- Tests should inspect stored rows directly to prove raw IDs do not leak.

---

## 6. Related Documents

- `docs/architecture/incident-storage-and-audit.md`
- `docs/architecture/incident-reporting.md`
- `docs/status/2026-03-13-incident-breakers-status.md`
