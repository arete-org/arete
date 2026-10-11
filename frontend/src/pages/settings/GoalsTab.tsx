import { cn } from '@/lib/utils';
import type { UserSettings } from '@/lib/api';
import { Field, Input } from '@/components/ui';
import type { SettingsTabProps } from './types';
import { RaceGoalsPanel } from './RaceGoalsPanel';
import { TrainingPacesPanel } from './TrainingPacesPanel';

/** "4:17" from 257 seconds per kilometre. */
function paceToText(seconds: number | null): string {
  if (!seconds) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 257 from "4:17"; null when the text is not a pace. */
function textToPace(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2})[:'.](\d{1,2})$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  return seconds >= 120 && seconds <= 900 ? seconds : null;
}

function numberOrNull(value: string, min: number, max: number): number | null {
  const n = Number(value);
  return value.trim() && n >= min && n <= max ? n : null;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABEL: Record<string, string> = {
  monday: 'LUN',
  tuesday: 'MAR',
  wednesday: 'MER',
  thursday: 'JEU',
  friday: 'VEN',
  saturday: 'SAM',
  sunday: 'DIM',
};
const GOALS = [
  { value: 'maintenance', label: 'MAINTIEN', desc: 'Garder le niveau actuel' },
  { value: 'build', label: 'CONSTRUCTION', desc: 'Monter la charge progressivement' },
  { value: 'peak', label: 'AFFÛTAGE', desc: 'Être au pic le jour J' },
  { value: 'recovery', label: 'RÉCUPÉRATION', desc: 'Phase de récupération active' },
];

export function GoalsTab({ settings, updateSetting }: SettingsTabProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary mb-4">OBJECTIFS</h2>

      <RaceGoalsPanel />

      <div className="space-y-6">
        <div>
          <label className="text-xs font-sans text-text-muted uppercase block mb-3">Objectif principal</label>
          <div className="grid grid-cols-2 gap-3">
            {GOALS.map((goal) => (
              <button
                key={goal.value}
                type="button"
                onClick={() => updateSetting('fitness_goal', goal.value as UserSettings['fitness_goal'])}
                className={cn(
                  'p-4 rounded border text-left transition-all',
                  settings.fitness_goal === goal.value
                    ? 'bg-neon-cyan/10 border-neon-cyan/50 text-neon-cyan'
                    : 'bg-abyss border-text-muted/20 text-text-muted hover:border-text-muted/40'
                )}
              >
                <div className="font-sans text-sm mb-1">{goal.label}</div>
                <div className="text-xs opacity-70 font-sans">{goal.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <Field label="Séances par semaine visées">
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="14"
              value={settings.weekly_training_goal}
              onChange={(e) => updateSetting('weekly_training_goal', parseInt(e.target.value))}
              className="flex-1"
            />
            <span className="text-xl font-sans text-neon-cyan w-12 text-center">
              {settings.weekly_training_goal}
            </span>
          </div>
        </Field>

        <div>
          <label className="text-xs font-sans text-text-muted uppercase block mb-3">Jours de repos préférés</label>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => {
                  const current = settings.rest_day_preference;
                  const updated = current.includes(day)
                    ? current.filter((d) => d !== day)
                    : [...current, day];
                  updateSetting('rest_day_preference', updated);
                }}
                className={cn(
                  'px-3 py-1.5 rounded text-xs font-sans uppercase transition-all',
                  settings.rest_day_preference.includes(day)
                    ? 'bg-neon-purple/20 text-neon-purple border border-neon-purple/30'
                    : 'bg-abyss text-text-muted border border-text-muted/20 hover:border-text-muted/40'
                )}
              >
                {DAY_LABEL[day]}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-text-muted/10 pt-6">
          <label className="text-xs font-sans text-text-muted uppercase block mb-1">Repères physiologiques</label>
          <p className="text-xs text-text-muted mb-1">
            Les zones cardiaques sont calculées à partir de ton seuil. Sans seuil, elles retombent sur la FC max.
          </p>
          <p className="text-xs text-text-muted mb-3">
            {settings.lthr_measured_on
              ? `Seuil mesuré par Garmin le ${new Date(`${settings.lthr_measured_on}T00:00:00`).toLocaleDateString('fr-FR')} : chaque synchro adopte un test plus récent.`
              : 'Aucun test Garmin repris pour le moment : la prochaine synchro ira le chercher.'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="FC au seuil (bpm)" hint="Test de 30 min : FC moyenne des 20 dernières minutes">
              <Input
                type="number"
                min={100}
                max={220}
                placeholder="176"
                value={settings.lthr ?? ''}
                onChange={(e) => updateSetting('lthr', numberOrNull(e.target.value, 100, 220))}
              />
            </Field>
            <Field label="FC max (bpm)" hint="Utilisée seulement si le seuil est vide">
              <Input
                type="number"
                min={120}
                max={230}
                placeholder="199"
                value={settings.max_hr ?? ''}
                onChange={(e) => updateSetting('max_hr', numberOrNull(e.target.value, 120, 230))}
              />
            </Field>
            <Field label="Allure au seuil" hint="Format m:ss par kilomètre">
              <Input
                type="text"
                inputMode="numeric"
                placeholder="4:17"
                defaultValue={paceToText(settings.threshold_pace_sec_km)}
                onBlur={(e) => updateSetting('threshold_pace_sec_km', textToPace(e.target.value))}
              />
            </Field>
          </div>
          <p className="text-xs text-text-muted mt-2">
            Un nouveau seuil s'applique aux séances qui arrivent. Pour réécrire aussi les anciennes, lance
            « Recalculer » dans l'onglet Système.
          </p>
        </div>

        <TrainingPacesPanel />

        <Field
          label="Seuil de préparation (%)"
          hint="Au-dessus de ce score, le conseil du jour propose une séance dure"
        >
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="50"
              max="100"
              value={settings.fatigue_threshold}
              onChange={(e) => updateSetting('fatigue_threshold', parseInt(e.target.value))}
              className="flex-1"
            />
            <span className="text-xl font-sans text-warning-orange w-12 text-center">
              {settings.fatigue_threshold}
            </span>
          </div>
        </Field>
      </div>
    </div>
  );
}
