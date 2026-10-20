import { useMemo } from 'react';
import { Field, Input, Panel, Select } from '@/components/ui';
import { timezoneGroups } from '@/lib/timezones';
import { useAuthState } from '@/components/auth/authState';
import { SignOutButton } from '@/components/auth/SignOutButton';
import type { SettingsTabProps } from './types';

export function ProfileTab({ settings, updateSetting }: SettingsTabProps) {
  const auth = useAuthState();
  // Some 400 zones, with their current offset: computed once per stored zone.
  const zones = useMemo(() => timezoneGroups(settings.timezone), [settings.timezone]);
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-sans text-text-primary mb-4">Profil</h2>

      <div className="space-y-4">
        <Field label="Nom affiché">
          <Input
            type="text"
            value={settings.display_name}
            onChange={(e) => updateSetting('display_name', e.target.value)}
          />
        </Field>

        <Field label="Adresse e-mail">
          <Input
            type="email"
            value={settings.email ?? ''}
            onChange={(e) => updateSetting('email', e.target.value || null)}
          />
        </Field>

        <Field label="Fuseau horaire">
          <Select value={settings.timezone} onChange={(e) => updateSetting('timezone', e.target.value)}>
            {zones.map((group) => (
              <optgroup key={group.region} label={group.region}>
                {group.zones.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
      </div>

      {auth.enabled && (
        <Panel level={3} variant="inset" title="Compte">
          <div className="space-y-3">
            <p className="text-sm font-sans text-text-secondary">
              Connecté en tant que <span className="text-text-primary">{auth.email}</span>
            </p>
            <SignOutButton signOut={auth.signOut} />
          </div>
        </Panel>
      )}
    </div>
  );
}
