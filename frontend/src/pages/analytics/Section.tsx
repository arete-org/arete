import type { ReactNode } from 'react';
import type { AnswerId } from '@/types';

export interface SectionDef {
  id: string;
  /** The question the section's cards serve. */
  title: string;
  /** Its label in the sticky jump bar, short enough for a phone. */
  short: string;
  /** The server answer that opens the page for this question. */
  answer: AnswerId;
  /** What the cards below show, in one sentence. */
  intro: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'pret', title: 'Suis-je prêt ?', short: 'Prêt ?', answer: 'ready', intro: 'La fraîcheur et la préparation de ta montre, puis tes mesures de récupération.' },
  { id: 'progres', title: 'Est-ce que je progresse ?', short: 'Progrès', answer: 'progress', intro: 'L’allure, le coût cardiaque, la vitesse en montée, la foulée et tes records ; la forme de fond est tracée sur la première carte de la page.' },
  { id: 'risque', title: 'Où est le risque ?', short: 'Risque', answer: 'risk', intro: 'L’ACWR, la monotonie et la montée de la forme de fond sur 7 jours, puis l’intensité, le dénivelé et la descente.' },
  { id: 'marche', title: 'Qu’est-ce qui marche ?', short: 'Ce qui marche', answer: 'works', intro: 'Tes semaines selon leurs jours d’entraînement, ton volume et la place de chaque sport.' },
];

/** Sticky jump bar: one click per question. */
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
              title={s.title}
              className="analysis-tab"
            >
              {s.short}
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
