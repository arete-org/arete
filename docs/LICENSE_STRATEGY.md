# LICENSE_STRATEGY.md  
*A living document for ARETE’s ethical licensing approach*

Version: 0.1 
Last updated: 2025-10-18  

---

## Current Status

ARETE is released under a **dual-license model**:

> **MIT License + Hippocratic License v3 (HL3)**

This dual structure combines the openness and accessibility of the MIT License with the moral commitments of the Hippocratic License v3, reflecting ARETE’s foundational principle: **freedom with responsibility**.

All components of the project are, by default, dual-licensed under both terms unless otherwise noted in their respective directories.  
Both `MIT_LICENSE.md` and `HIPPOCRATIC_LICENSE.md` are included in the repository root for clarity.

---

## Motivation: “AI Done Right”

ARETE was imagined not just as another AI tool, but as a **moral co-thinker**. Its design centers around transparency, value reasoning, and public auditability. Its outputs are explainable, traceable, and ethically weighted.  
To be consistent with that mission, the **terms under which ARETE itself is built and used** must also be morally coherent and transparent.

The **Hippocratic License v3** aligns with this vision by embedding moral constraints directly into the license itself. Specifically, it forbids uses that violate fundamental human rights, and allows modular extensions to cover additional harms (e.g., surveillance, labor exploitation, environmental destruction).

This licensing shift is not a symbolic gesture—it is a deliberate extension of ARETE’s **provenance-aware architecture**, where ethical lineage is treated not as annotation, but as a **foundational element** of system design.

---

## Active Scope

The following **HL3 clauses** are currently active within ARETE’s ethical scope:

- **Human Rights Clause** — Forbids use in systems that infringe upon internationally recognized human rights, including bodily autonomy and freedom of expression.  
- **No State Violence / Torture / Genocide Clause** — Disallows deployment for violence, detention, or state coercion.  
- **Slavery / Forced Labor Clause** — Prohibits use in systems tied to forced labor, trafficking, or exploitative labor conditions.

These represent ARETE’s **ethical baseline**—a non-negotiable set of moral commitments embedded in its license and provenance model.

---

## Anticipated Modules

As ARETE’s domain, architecture, and adoption mature, I intend to evaluate adding further HL3 modules that align with our moral commitments and technical risk landscape. Below are candidate modules; each will be introduced only after rigorous deliberation and community feedback.

- **Surveillance & Privacy Clause**  
  Restricts deployment in systems designed for unwarranted surveillance, biometric tracking, mass data profiling, or persistent behavior monitoring.

- **Manipulation / Disinformation Clause**  
  Prohibits usage in systems optimized for misinformation, coercion, behavior-targeting, addiction loops, or manipulative content recommendation.

- **Ecological / Environmental Harm Clause**  
  Disallows integration with systems contributing to large-scale deforestation, extractivist supply chains, biodiversity destruction, or fossil-fuel–intensive infrastructure.

- **Labor & Supply Chain Rights Clause**  
  Forbids deployment in systems built on exploitative labor conditions, child labor, unsafe working conditions, or opaque supply chains.

- **Data Exploitation & Extraction Clause**  
  Prevents usage in systems that systematically exploit, commodify, or monetize sensitive personal data (e.g. behavioral tracking, surveillance capitalism) without consent and fair compensation.

- **Autonomous Weapons / Lethal Use Clause**  
  Prohibits use of ARETE in autonomous or semi-autonomous lethal systems, weaponized drones, or systems that issue lethal force decisions without human oversight.

- **Social Harms & Discrimination Clause**  
  Restricts deployment in systems that exacerbate biases, systemic injustice, hate speech amplification, disenfranchisement, or suppression of marginalized groups.

- **Medical / Biotech Misuse Clause**  
  Disallows use of ARETE in systems that facilitate harmful biotech or medical interventions (e.g. coercive medical diagnosis, bioweapon design) unless subject to independent ethical oversight.

- **Economic Exploitation Clause**  
  Prohibits use in systems that enable extractive financial strategies, predatory lending, exploitative pricing algorithms, or debt traps.

- **Political Influence / Election Interference Clause**  
  Prevents deployment in systems built to manipulate elections, microtarget political persuasion, or covertly influence civic behavior.

Each new module will be added only after:
1. Ethical deliberation (internally and publicly)  
2. Impact evaluation and risk modeling  
3. Contributor and stakeholder feedback  
4. Provenance model updates (annotating modules in the licensing metadata)  
5. Documentation and transparency in `ETHICS_DECISIONS.md`

---

## Integration with ARETE’s Ethical Architecture

Licensing in ARETE isn’t a static text file—it’s an active part of its ethical reasoning layer.  
Every reasoning session, code artifact, and document may carry metadata such as:

```json
"license_context": "MIT + Hippocratic-3.0",
"ethical_constraints": ["no forced labor", "no genocide", "human rights"],
"license_provenance": "LICENSE_STRATEGY.md@v0.2"
```

This connects licensing to provenance: any AI reasoning process can reference its ethical lineage directly, reinforcing transparency and moral accountability.

---

## Future Work
- Add `license_context` to TerminusDB schema
- Extend `/explain` command to include license lineage
- Draft `USE_POLICY.md` with clear “red lines” and examples
- Write `ETHICS_DECISIONS.md` entry explaining rationale
- Consider a `LICENSE_FAQ.md` to help contributors navigate concerns
- Reach out to legal/ethical advisors for review of HL3 interpretation
- Seek legal and ethical review of dual-license interoperability

---

## Community Participation

Licensing is not a one-time choice but a living social contract.
Contributors and users are invited to participate in shaping this evolving framework.

Feedback and proposals are welcome via:
- GitHub Discussions
- Pull Requests to this file

---

## Closing Thought

The goal isn’t to police behavior through licensing—it’s to help ensure that what we build reflects the values we care about.

A license, like a compass, doesn’t force a direction—but it helps keep us oriented toward what matters.

---
