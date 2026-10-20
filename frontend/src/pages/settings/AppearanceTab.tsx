import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { SettingsTabProps } from './types';
import { SYSTEM_THEMES, THEMES, type ThemePreference } from '@/lib/theme';
import { AreteWordmark } from '@/components/AreteBrand';

const palette = (value: string) => THEMES.find((theme) => theme.value === value)!;
const day = palette(SYSTEM_THEMES.light);
const night = palette(SYSTEM_THEMES.dark);

/** « Système » previews both palettes it may show: the day above, the night below. */
const CHOICES: { value: ThemePreference; label: string; preview: CSSProperties }[] = [
  {
    value: 'system',
    label: 'Système',
    preview: {
      backgroundImage: `linear-gradient(180deg, ${day.color} 50%, ${night.color} 50%)`,
      color: day.foreground,
    },
  },
  ...THEMES.map((theme) => ({
    value: theme.value,
    label: theme.label,
    preview: { backgroundColor: theme.color, color: theme.foreground },
  })),
];

export function AppearanceTab({ settings, updateSetting }: SettingsTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-text-primary">Apparence</h2>
        <p className="mt-2 text-sm text-text-secondary">
          Une même identité, quatre atmosphères. « Système » suit ton appareil : {day.label} en mode clair, {night.label} en mode sombre.
        </p>
      </div>

      <div className="theme-picker">
        <label className="text-xs font-sans text-text-muted block mb-3">Thème</label>
        <div className="theme-options" role="group" aria-label="Thème">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={settings.theme === choice.value}
              aria-label={choice.label}
              data-theme-choice={choice.value}
              onClick={() => updateSetting('theme', choice.value)}
              className="theme-option min-w-0 p-3 text-left transition-colors motion-reduce:transition-none"
            >
              <span className="theme-preview flex min-h-36 flex-col justify-between gap-4 p-3" style={choice.preview} aria-hidden="true">
                <AreteWordmark />
                <span className="block" style={choice.value === 'system' ? { color: night.foreground } : undefined}>
                  <span className="block font-display text-2xl font-semibold leading-tight">Ta prochaine séance</span>
                  <span className="mt-1 block text-xs font-sans">45 min · Endurance</span>
                </span>
              </span>
              <span className="mt-3 flex items-center justify-between gap-2 text-xs font-sans text-text-primary">
                {choice.label}
                {settings.theme === choice.value && <Check className="size-4 text-neon-cyan" aria-hidden="true" />}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-text-secondary">Aperçu immédiat. Enregistre pour conserver ce thème.</p>
      </div>
    </div>
  );
}
