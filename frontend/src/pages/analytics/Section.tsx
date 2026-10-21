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
  { id: 'pret', title: 'Suis-je prêt ?', short: 'Prêt ?', answer: 'ready', intro: 'La forme de fond, la fatigue et la fraîcheur, puis les mesures de récupération de ta montre.' },
  { id: 'progres', title: 'Est-ce que je progresse ?', short: 'Progrès', answer: 'progress', intro: 'L’allure, le coût cardiaque, la vitesse en montée et tes records.' },
  { id: 'risque', title: 'Où est le risque ?', short: 'Risque', answer: 'risk', intro: 'Le volume, la répartition de l’intensité et le dénivelé, qui font monter la charge.' },
  { id: 'marche', title: 'Qu’est-ce qui marche ?', short: 'Ce qui marche', answer: 'works', intro: 'La place de chaque sport, ta foulée et ta descente.' },
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
