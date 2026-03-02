# LICENSE_STRATEGY.md

_A living document for Footnote's licensing approach_

Version: 0.1
Last updated: 2026-03-02

---

## Current Status

Footnote is released under a **dual-license model**, combining the openness and accessibility of the [MIT License](../MIT_LICENSE.md) with the moral commitments of the [Hippocratic License v3](../HIPPOCRATIC_LICENSE.md).

All components of the project are, by default, dual-licensed under both terms unless otherwise noted.  

---

## Motivation

Footnote's design centers around transparency, value reasoning, and public auditability. Its outputs are ethically weighted and traceable. To be consistent with that mission, the terms under which the project itself is built and used must also be transparent and morally coherent.  

The Hippocratic License aligns with this vision by embedding moral constraints directly into the license itself. Specifically, it forbids uses that violate fundamental human rights, and allows modular extensions to cover additional harms (e.g., surveillance, labor exploitation, environmental destruction).

---

## Active Scope

The following HL3 clauses are currently active within Footnote's ethical scope:

- **Human Rights Clause** — Forbids use in systems that infringe upon internationally recognized human rights, including bodily autonomy and freedom of expression.
- **No State Violence / Torture / Genocide Clause** — Disallows deployment for violence, detention, or state coercion.
- **Slavery / Forced Labor Clause** — Prohibits use in systems tied to forced labor, trafficking, or exploitative labor conditions.

These represent the project's ethical baseline.

---

## Future Modules

As Footnote's domain, architecture, and adoption mature, we intend to evaluate adding further HL3 modules that align with our moral commitments and technical risk landscape. Candidate modules include:

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
  Prohibits use of Footnote in autonomous or semi-autonomous lethal systems, weaponized drones, or systems that issue lethal force decisions without human oversight.

- **Social Harms & Discrimination Clause**  
  Restricts deployment in systems that exacerbate biases, systemic injustice, hate speech amplification, disenfranchisement, or suppression of marginalized groups.

- **Medical / Biotech Misuse Clause**  
  Disallows use of Footnote in systems that facilitate harmful biotech or medical interventions (e.g. coercive medical diagnosis, bioweapon design) unless subject to independent ethical oversight.

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

## Integration with the Project's Ethical Architecture

Licensing in Footnote is an active part of the ethical reasoning layer.  
Every reasoning session, code artifact, and document may carry metadata such as:

```json
"license_context": "MIT + Hippocratic-3.0",
"ethical_constraints": ["no forced labor", "no genocide", "human rights"],
"license_provenance": "LICENSE_STRATEGY.md@v0.2"
```

This connects licensing to provenance: any AI reasoning process can reference its ethical lineage directly.

---

## Community Participation

Licensing is not a one-time choice but a living social contract. Contributors and users are invited to participate in shaping this evolving framework!

Feedback and proposals are welcome via:

- GitHub Discussions
- Pull Requests to this file

The goal isn’t to police behavior through licensing, but to help ensure that what we build reflects the values we care about. Like a compass, licensing doesn’t force a direction, but helps keep us oriented toward what matters.
