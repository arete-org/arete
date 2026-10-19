import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Field, Input, Panel } from '@/components/ui';
import type { SettingsTabProps } from './types';

const QUICK_REFERENCE = [
  ['2x8 @80 bench press', '2 séries de 8 répétitions à 80 kg'],
  ['3@100, 1@105 squat', 'séries dégressives'],
  ['5x(10 pull ups, 15 dips) r2\'', 'circuit, 5 tours, 2 min de repos'],
  ['(pull ups) 3x amrap', 'finisher, jusqu\'à l\'échec'],
  ['r1\'30', 'repos 1 min 30'],
  ['EMOM 20\' (odd: 10 pull ups, even: 10 chin ups)', 'une série au départ de chaque minute'],
];

export function WorkoutTab({ settings, updateSetting }: SettingsTabProps) {
  const [newAbbrev, setNewAbbrev] = useState('');
  const [newFull, setNewFull] = useState('');

  const abbreviations = settings.exercise_abbreviations ?? {};
  const entries = Object.entries(abbreviations).sort(([a], [b]) => a.localeCompare(b));

  const handleAdd = () => {
    const key = newAbbrev.trim().toLowerCase();
    const value = newFull.trim().toLowerCase();
    if (!key || !value) return;
    updateSetting('exercise_abbreviations', { ...abbreviations, [key]: value });
    setNewAbbrev('');
    setNewFull('');
  };

  const handleRemove = (key: string) => {
    const updated = { ...abbreviations };
    delete updated[key];
    updateSetting('exercise_abbreviations', updated);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary mb-4">NOTATION DES SÉANCES</h2>

      <div>
        <label className="text-xs font-sans text-text-muted uppercase block mb-2">
          Abréviations d'exercices
        </label>
        <p className="text-xs text-text-muted font-sans mb-4">
          Associe tes raccourcis aux noms complets pour que l'analyseur comprenne ta notation.
          <br />
          Exemple : <span className="text-neon-cyan">bp</span> &rarr; <span className="text-neon-cyan">bench press</span>,{' '}
          <span className="text-neon-cyan">ng</span> &rarr; <span className="text-neon-cyan">neutral grip</span>
        </p>

        {entries.length > 0 && (
          <ul className="space-y-1 mb-4">
            {entries.map(([abbrev, full]) => (
              <li
                key={abbrev}
                className={cn(
                  'grid grid-cols-[8rem_1rem_minmax(0,1fr)_2rem] items-center gap-2 px-3 py-2 rounded',
                  'bg-abyss/50 border border-text-muted/20',
                  'group hover:border-text-muted/40 transition-all'
                )}
              >
                <span className="font-sans text-sm text-neon-cyan truncate" title={abbrev}>
                  {abbrev}
                </span>
                <span className="text-text-muted font-sans text-xs">&rarr;</span>
                <span className="font-sans text-sm text-text-primary truncate" title={full}>
                  {full}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(abbrev)}
                  aria-label={`Supprimer ${abbrev}`}
                  className="justify-self-end opacity-60 group-hover:opacity-100 text-danger-red hover:text-danger-red/80 transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-[10rem_minmax(0,1fr)] gap-3">
          <Field label="Abréviation" gap="sm">
            <Input
              value={newAbbrev}
              onChange={(e) => setNewAbbrev(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="bp"
              className="text-neon-cyan"
            />
          </Field>
          <Field label="Nom complet de l'exercice" gap="sm">
            <Input
              value={newFull}
              onChange={(e) => setNewFull(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="bench press"
            />
          </Field>
        </div>
        <Button
          className="mt-3"
          onClick={handleAdd}
          disabled={!newAbbrev.trim() || !newFull.trim()}
        >
          <Plus className="w-4 h-4" />
          AJOUTER
        </Button>
      </div>

      <Panel level={3} variant="inset" title="Mémo de notation">
        <div className="space-y-1.5 font-sans text-xs">
          {QUICK_REFERENCE.map(([notation, meaning]) => (
            <div key={notation} className="flex gap-3">
              <span className="text-neon-cyan w-44 shrink-0">{notation}</span>
              <span className="text-text-muted">{meaning}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
