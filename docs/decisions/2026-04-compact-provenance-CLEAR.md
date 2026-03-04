# CLEAR Response Temperament + Compact UI Provenance

**Decision:** Standardize CLEAR as Footnote’s canonical response-temperament profile (logged as structured provenance) and render it in Discord as a compact generated image footer.  
**Date:** 2026-03-04

---

## 1. Context

Footnote surfaces provenance and risk-tiering, but users also need a compact, consistent way to see *how* an answer is expressed: how careful it is, how long it is, how much reasoning it exposes, how firm it sounds, and how many perspectives it brings in.

CLEAR exists to make those expression choices inspectable and auditable. It should be visually appealing, efficient at communicating temperament axes, and small enough to appear on every response without being distracting.

In Discord, plaintext provenance footers consume vertical space and user attention, especially on mobile. The goal is to keep CLEAR visible while reducing friction and noise.

---

## 2. CLEAR Definition

CLEAR is a 5-axis temperament profile:

- **C — Care:** caution, safeguards, and attention to nuance.
- **L — Length:** how concise vs expansive the response is.
- **E — Elaboration:** how much reasoning/process is shown (not just conclusion).
- **A — Assurance:** strength of claims and degree of hedging.
- **R — Reach:** breadth of perspectives, alternatives, or frames considered.

Each axis is a scalar from **1–10**. Higher values mean “more of that thing” in the visible behavior of the answer.

---

## 3. Decision

### 3.1 Canonical model (logging + internal contracts)

CLEAR is stored canonically as **1–10 per axis** in traces/logs and any internal APIs.

### 3.2 Discord UI representation (compact, always-on)

In Discord, CLEAR is rendered as a **generated image** that is wide but short:

- A **CLEAR wheel** on the left (fixed placement).
- A small set of compact “chips” on the right (limited to what fits without increasing height).

The CGI is attached to the message and referenced by an embed field (thumbnail or image slot), keeping the on-screen footprint predictable.

---

## 4. Rationale

- CLEAR must be visible by default to support “inspectability,” but it must not dominate the chat UI.
- Discord’s layout penalizes tall footers. A compact image conveys the same information in less vertical space.
- Keeping 1–10 canonical avoids churn across the system; the CGI becomes a presentation layer over stable stored values.

---

## 5. Alternatives Considered

- **Plaintext stat line in every message footer:** readable but too tall/noisy over time in Discord.
- **Intensity-only slices:** harder to interpret at small sizes, less “countable” than discrete structure.
- **Remove CLEAR from default UI and show only on demand:** undermines the “visible provenance” intent.

---

## 6. Implementation Notes (Discord-first)

### 6.1 Wheel spec (v1)

- Wheel has **5 slices** in fixed order: **C / L / E / A / R**.
- Each slice is subdivided into **5 concentric radial bands** (inner → outer).
- CLEAR values remain **1–10**, rendered continuously across the 5 bands:
  - Each band represents a 2-point range.
  - Values can land **between** bands via partial fill of the current band.
  - Example mapping for a value `v`:
    - `t = clamp(v / 10, 0, 1)` (continuous fill proportion)
    - Fill bands from inner outward, with the outermost filled fraction matching `t`.

**Visual rule (per slice):**
- Filled region uses the slice’s axis color.
- Unfilled region uses a muted version of the same hue (not grayscale).
- Use thin neutral dividers between slices so boundaries read at small sizes.
- Label slices with a single-letter glyph (**C L E A R**) at or near the rim.

This yields a wheel that is:
- compact,
- legible at small sizes, and
- “pleasant” because intermediate values visibly land between band boundaries.

### 6.2 Color assignment

- Colors are stable per axis (consistent across messages).
- Colors are treated as part of the UI contract; changes should be rare and coordinated.

### 6.3 CGI layout

Recommended starting size (adjust as needed):
- **Canvas:** ~360×72 or 400×80, transparent PNG.
- **Left:** wheel (e.g., 64×64 with padding).
- **Right:** 1–3 compact chips max (no paragraphs).

Chip candidates (pick a small subset):
- confidence (numeric or small tick bar)
- risk tier (single token: Low/Med/High)
- a single “trade-offs” indicator (icon-only)

### 6.4 Trace/log shape (example)

Canonical stored values remain 1–10; the renderer may store a wheel version for auditability:

```json
{
  "clear": { "C": 9, "L": 6, "E": 8, "A": 6, "R": 7 },
  "clearWheelVersion": "v1"
}