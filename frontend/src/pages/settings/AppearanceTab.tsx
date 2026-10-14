import { Check } from 'lucide-react';
import type { SettingsTabProps } from './types';
import { THEMES } from '@/lib/theme';
import { AreteWordmark } from '@/components/AreteBrand';

export function AppearanceTab({ settings, updateSetting }: SettingsTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-text-primary">Apparence</h2>
        <p className="mt-2 text-sm text-text-secondary">Une même identité, huit atmosphères. Choisis celle qui accompagne ton entraînement.</p>
      </div>

      <div className="theme-picker">
        <label className="text-xs font-sans text-text-muted uppercase block mb-3">Thème</label>
        <div className="theme-options" role="group" aria-label="Thème">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              aria-pressed={settings.theme === theme.value}
              aria-label={theme.label}
              onClick={() => updateSetting('theme', theme.value)}
              className="theme-option min-w-0 p-3 text-left transition-colors motion-reduce:transition-none"
            >
              <span className="theme-preview flex min-h-36 flex-col justify-between gap-4 p-3" style={{ backgroundColor: theme.color, color: theme.foreground }} aria-hidden="true">
                <AreteWordmark />
                <span className="block">
                  <span className="block font-display text-2xl font-semibold leading-tight">Ta prochaine séance</span>
                  <span className="mt-1 block text-xs font-sans">45 min · Endurance</span>
                </span>
              </span>
              <span className="mt-3 flex items-center justify-between gap-2 text-xs font-sans text-text-primary">
                {theme.label}
                {settings.theme === theme.value && <Check className="size-4 text-neon-cyan" aria-hidden="true" />}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-text-secondary">Aperçu immédiat. Enregistre pour conserver ce thème.</p>
      </div>
    </div>
  );
}
