# TRACE: Response Temperament + Compact UI Provenance

**Decision:** Standardize TRACE as Footnote’s canonical response-temperament profile (logged as structured provenance) and render it in Discord as a compact generated image footer.  
**Date:** 2026-03-04

---

## 1. Context

Footnote surfaces provenance and risk-tiering, but users also need a compact, consistent way to see _how_ an answer is expressed: how demanding it is to read, how much “why” it shows, how clearly it separates sourced vs inferred content, how cautiously it behaves, and how many options/perspectives it offers.

TRACE exists to make those expression choices inspectable and auditable. It should be visually appealing, efficient at communicating temperament axes, and small enough to appear on every response without being distracting.

In Discord, plaintext provenance footers consume vertical space and user attention, especially on mobile. The goal is to keep TRACE visible while reducing friction and noise.

---

## 2. TRACE Definition

TRACE is a 5-axis temperament profile:

- **T — Tightness:** how efficiently the response uses space and attention (concision + structure, not just shortness).
- **R — Rationale:** how much “why” is shown inline (assumptions, steps, trade-offs), beyond the conclusion.
- **A — Attribution:** how clearly the response marks boundaries between sourced/retrieved content, inference, and speculation.
- **C — Caution:** how strongly the response applies safeguards and avoids overclaiming (behavioral stance, not risk classification).
- **E — Extent:** breadth of viable options, perspectives, or frames presented to support user choice.

Each axis is a scalar from **1–5**. Higher values mean “more of that thing” in the visible behavior of the answer.

---

## 3. Decision

### 3.1 Canonical model (logging + internal contracts)

TRACE is stored canonically as **1–5 per axis** in traces/logs and any internal APIs.

### 3.2 Discord UI representation (compact, always-on)

In Discord, TRACE is rendered as a **generated image** that is wide but short:

- A **TRACE wheel** on the left (fixed placement).
- A small set of compact “chips” on the right (limited to what fits without increasing height).

The CGI is attached to the message and referenced by an embed field (thumbnail or image slot), keeping the on-screen footprint predictable.

---

## 4. Rationale

- TRACE must be visible by default to support inspectability, but it must not dominate the chat UI.
- Discord’s layout penalizes tall footers. A compact image conveys the same information in less vertical space.
- Keeping 1–5 canonical avoids churn across the system; the CGI becomes a presentation layer over stable stored values.

---

## 5. Implementation Notes

### 5.1 Wheel spec

- Wheel has **5 slices** in fixed order: **T / R / A / C / E**.
- Each slice is subdivided into **5 concentric radial bands**.
- TRACE values remain **1–5**, rendered continuously across the 5 bands:
    - Each band represents a 1-point range.
    - Values can land **between** bands via partial fill of the current band.
    - Example mapping for a value `v`:
        - `t = clamp((v - 1) / 4, 0, 1)` (continuous fill proportion)
        - Fill bands from inner outward, with the outermost filled fraction matching `t`.

**Visual rule (per slice):**

- Filled region uses the slice’s axis color.
- Unfilled region uses a muted version of the same hue (not grayscale).
- Use thin neutral dividers between slices so boundaries read at small sizes.
- Label slices with a single-letter glyph (**T R A C E**) at or near the rim.

This yields a wheel that is:

- compact,
- legible at small sizes, and
- “pleasant” because intermediate values visibly land between band boundaries.

### 5.2 Color assignment

- Colors are stable per axis (consistent across messages).
- Colors are treated as part of the UI contract; changes should be rare and coordinated.

### 5.3 CGI layout

Recommended starting size (adjust as needed):

- **Canvas:** ~360×72 or 400×80, transparent PNG.
- **Left:** wheel (e.g., 64×64 with padding).
- **Right:** 1–3 compact chips max (no paragraphs).

Chip candidates (pick a small subset):

- evidence score (numeric or small tick bar)
- freshness score (numeric or small tick bar)
- risk tier (single token: Low/Med/High)
- a single “trade-offs” indicator (icon-only)

### 5.4 Trace/log shape (example)

Canonical stored values remain 1–5; the renderer may store a wheel version for auditability:

```json
{
    "trace": { "T": 5, "R": 3, "A": 4, "C": 3, "E": 4 }
}
```
