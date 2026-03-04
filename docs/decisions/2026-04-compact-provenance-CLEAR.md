# CLEAR: Response Temperament + Compact UI Provenance

**Decision:** Standardize CLEAR as the canonical response-temperament profile (logged as structured provenance) and render it in Discord as a compact generated image footer.  
**Date:** 2026-03-04

---

## 1. Context

Footnote already surfaces provenance and risk-tiering, but we also need a compact, consistent way to show *how* an answer is expressed: how careful it is, how long it is, how much reasoning it exposes, how firm it sounds, and how many perspectives it brings in. CLEAR exists to make those “expression choices” inspectable and auditable.

CLEAR is designed to show up as **visible provenance metadata**: a small stat block attached to responses, and a structured field in logs. :contentReference[oaicite:3]{index=3}

In Discord, we append provenance to every response. A plaintext footer competes for attention and consumes vertical space, especially on mobile. The goal is to keep CLEAR *visible* while making it minimally intrusive by default.

---

## 2. Decision

### 2.1 Canonical model (logging + internal contracts)

CLEAR is a 5-axis temperament profile:

- **C — Care**
- **L — Length**
- **E — Elaboration**
- **A — Assurance**
- **R — Reach**

Each axis is a scalar from **1–10**. Higher values mean “more of that thing” in the visible behavior of the answer. :contentReference[oaicite:4]{index=4}

The canonical values remain **1–10** in traces/logs and in any internal APIs.

### 2.2 Discord UI representation (compact, always-on)

In Discord, CLEAR is rendered as a **generated image** (CGI) that is wide but short:

- A **CLEAR wheel** on the left (fixed placement).
- A small set of compact “chips” on the right (e.g., confidence, risk tier), limited to what fits without increasing height.

The CGI is attached to the message and referenced in an embed thumbnail or image slot (implementation choice), keeping the on-screen footprint predictable.

### 2.3 Display scale (1–5 visual bands)

For the wheel UI only, CLEAR is displayed on a **1–5** scale, derived from canonical 1–10:

- `display = ceil(canonical / 2)` (values 1–5)

This is a presentation mapping; it does not change the canonical stored values.

---

## 3. Rationale

- CLEAR is explicitly intended to be *visible provenance metadata* :contentReference[oaicite:5]{index=5}; making it visual reduces friction while keeping the “you can inspect it” promise.
- Discord’s layout penalizes tall footers. A compact image conveys the same information in less vertical space.
- Keeping **1–10** canonical preserves existing semantics and avoids churn across the system, while **1–5** improves legibility in small UI.

---

## 4. Alternatives Considered

- **Plaintext stat line in every message footer**: readable but too tall/noisy over time in Discord.
- **Intensity-only slices**: harder to interpret at small sizes, less “countable” than discrete bands.
- **Character/archetype per combination**: not scalable without heavy bucketing (combination explosion).
- **Remove CLEAR from default UI and show only on demand**: conflicts with CLEAR’s “visible provenance” intent. :contentReference[oaicite:6]{index=6}

---

## 5. Consequences

- Users get an always-visible, low-noise signal of response temperament (CLEAR) without paying a large attention/space cost.
- CLEAR becomes more consistent across channels because the canonical 1–10 values remain stable, and UI transforms are purely representational.
- We must treat the CGI renderer as a user-facing contract: changes to colors, layout, or mapping should be deliberate and versioned.

---

## 6. Implementation Notes

### 6.1 CLEAR semantics (unchanged)

CLEAR continues to describe **temperament, not tactics** (expression, not guardrails/cost/citation count). :contentReference[oaicite:7]{index=7}

Assurance remains constrained by uncertainty and risk tier; requested vs effective assurance are both tracked. :contentReference[oaicite:8]{index=8}

### 6.2 Wheel spec

- Wheel has **5 slices** in fixed order: **C / L / E / A / R**.
- Each slice is subdivided into **5 concentric radial bands** (inner → outer).
- Fill bands from inner outward up to `display` (1–5).
- Unfilled bands use a muted version of the slice color (same hue).
- Slices have thin neutral dividers so boundaries remain visible at small sizes.
- Each slice is labeled (single-letter glyph or micro-label near the rim).

### 6.3 Color assignment

- Colors are stable per axis (consistent across messages).
- Colors are treated as part of the UI contract; changes should be rare and coordinated.

### 6.4 CGI layout (Discord-first)

Recommended starting size (adjust as needed):
- **Canvas**: ~360×72 or 400×80, transparent PNG.
- **Left**: wheel (e.g., 64×64 with padding).
- **Right**: 1–3 compact chips max (no paragraphs).

Chip candidates (pick a small subset):
- confidence (e.g., 0–100 or 1–5 ticks)
- risk tier (single token: Low/Med/High)
- “trade-offs present” indicator (icon-only), with details behind existing buttons

### 6.5 Accessibility + fallback

- The ephemeral “Explain” panel provides a text fallback: canonical CLEAR values and a copy/paste-friendly line.
- Do not rely on color alone: include slice labels and consistent ordering.

### 6.6 Caching + versioning

- Cache generated assets by a key like:
  - `clearWheel:v1:C,L,E,A,R:confidence:riskTier:theme`
- Increment the wheel version if mapping/layout changes.

### 6.7 Trace/log shape (example)

Canonical stored values remain 1–10:

```json
{
  "clear": { "C": 9, "L": 6, "E": 8, "A": 6, "R": 7 },
  "clearDisplay": { "C": 5, "L": 3, "E": 4, "A": 3, "R": 4 },
  "clearWheelVersion": "v1"
}