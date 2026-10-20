import type { ReactNode } from 'react';

export interface SectionDef {
  id: string;
  title: string;
  /** What this section is for, in one sentence. */
  intro: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'charge', title: 'Charge', intro: 'Le volume réalisé et l’équilibre entre forme de fond, fatigue et fraîcheur.' },
  { id: 'intensite', title: 'Intensité', intro: 'Le temps passé dans chaque zone et la place de chaque sport.' },
  { id: 'efficacite', title: 'Efficacité', intro: 'La relation entre l’allure et l’effort cardiaque, avec tes meilleurs chronos.' },
  { id: 'terrain', title: 'Terrain & foulée', intro: 'La montée, la descente et les caractéristiques de ta foulée.' },
  { id: 'recuperation', title: 'Récupération', intro: 'Les mesures Garmin disponibles, leur tendance et leur couverture.' },
];

/** Sticky jump bar: one click per section. */
export function SectionNav({ active, onJump }: { active: string; onJump: (id: string) => void }) {
  return (
    <nav aria-label="Sections des analyses">
      <ul className="flex gap-2 flex-wrap">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onJump(s.id)}
              aria-current={active === s.id ? 'true' : undefined}
              className="analysis-tab"
            >
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Section({ def, children }: { def: SectionDef; children: ReactNode }) {
  return (
    <section id={def.id} className="analysis-section" aria-labelledby={`${def.id}-title`}>
      <header>
        <h2 id={`${def.id}-title`} className="text-text-primary">{def.title}</h2>
        <p className="text-sm text-text-muted">{def.intro}</p>
      </header>
      <div className="analysis-grid">{children}</div>
    </section>
  );
}
