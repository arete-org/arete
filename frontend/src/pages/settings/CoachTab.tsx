import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BookOpen, Brain, RefreshCw, Sunrise, Wand2 } from 'lucide-react';
import { Panel, Button } from '@/components/ui';
import { garminApi, notificationsApi } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { currentState, subscribeDevice, unsubscribeDevice, type PushState } from '@/lib/push';
import { qk } from '@/lib/queryKeys';
import type { SettingsTabProps } from './types';
import { AthleteFactsPanel } from './AthleteFactsPanel';

interface LedgerFile {
  name: string;
  content: string;
}

interface LedgerResponse {
  files: LedgerFile[];
}

const FILE_META: Record<string, { label: string; icon: typeof Brain; hint: string }> = {
  'sessions.md': {
    label: 'Journal des séances',
    icon: BookOpen,
    hint: "Une entrée par séance dont le coach discute — faits, ressentis, décisions.",
  },
  'notes.md': {
    label: 'Notes durables',
    icon: Brain,
    hint: 'Observations du coach, à distinguer des faits déclarés ci-dessus.',
  },
};

/** One saved-with-the-form switch: a checkbox, its explanation and an optional hint. */
function SettingSwitch({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        className="accent-neon-cyan mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm text-text-secondary">
        {children}
        {hint && (
          <>
            <br />
            <span className="text-xs text-text-muted">{hint}</span>
          </>
        )}
      </span>
    </label>
  );
}

function AdaptationPanel({ settings, updateSetting }: SettingsTabProps) {
  const { data: syncStatus } = useQuery({ queryKey: qk.syncStatus, queryFn: garminApi.getSyncStatus });
  const garminMissing = syncStatus != null && !syncStatus.garmin_authenticated;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Wand2 className="size-4 text-neon-purple" /> Propositions du coach
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">Chiron propose des ajustements sur l’accueil. Ton planning change uniquement après ta validation ou ta demande explicite dans le chat.</p>
        <SettingSwitch
          checked={settings.push_to_garmin_enabled}
          onChange={(value) => updateSetting('push_to_garmin_enabled', value)}
          hint="Nécessite Garmin connecté. La montre récupère la séance à sa prochaine synchronisation avec le téléphone."
        >
          Envoyer automatiquement les séances cardio du jour sur le calendrier Garmin.
        </SettingSwitch>
        {garminMissing && (
          <p className="text-xs text-warning-orange">
            Garmin n’est pas connecté : l’envoi sur la montre est inactif (onglet Connexions).
          </p>
        )}
      </div>
    </Panel>
  );
}

const DEVICE_HINT: Partial<Record<PushState, string>> = {
  unsupported: 'Ce navigateur ne gère pas les notifications push.',
  'ios-not-installed':
    'Sur iPhone et iPad, les notifications ne marchent que dans l’app installée (iOS 16.4 ou plus) : ajoute Arete à l’écran d’accueil puis active depuis l’app.',
  'no-worker':
    'Service worker absent : les notifications ne marchent qu’avec l’app compilée, pas en mode développement.',
  denied: 'Notifications refusées pour ce site : autorise-les dans les réglages du navigateur, puis recharge la page.',
};

function NotificationsPanel({ settings, updateSetting }: SettingsTabProps) {
  const queryClient = useQueryClient();
  const { data: state } = useQuery({ queryKey: qk.pushState, queryFn: currentState, staleTime: Infinity });
  const { data: vapid } = useQuery({ queryKey: qk.vapidKey, queryFn: notificationsApi.getVapidPublicKey });
  const [busy, setBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // A plain handler, not a mutation: Safari only shows the permission prompt
  // when it is requested synchronously from the click.
  const runDevice = async (action: () => Promise<PushState>) => {
    setBusy(true);
    setDeviceError(null);
    try {
      queryClient.setQueryData(qk.pushState, await action());
    } catch {
      setDeviceError('Échec : réessaie, ou vérifie la connexion au serveur.');
      queryClient.invalidateQueries({ queryKey: qk.pushState });
    } finally {
      setBusy(false);
    }
  };

  const test = useMutation({ mutationFn: notificationsApi.sendTest });
  const testResult = test.data
    ? test.data.skipped_reason
      ? `Aucun envoi : ${test.data.skipped_reason}`
      : `Test envoyé à ${test.data.sent} appareil${test.data.sent > 1 ? 's' : ''}` +
        (test.data.dropped ? ` · ${test.data.dropped} abonnement(s) expiré(s) retiré(s)` : '')
    : null;

  const hint = state ? DEVICE_HINT[state] : undefined;
  const vapidKey = vapid?.key ?? null;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Bell className="size-4 text-neon-cyan" /> Notifications
        </span>
      }
    >
      <div className="space-y-3">
        <SettingSwitch
          checked={settings.notifications_enabled}
          onChange={(value) => updateSetting('notifications_enabled', value)}
          hint="Décoché, le serveur n’envoie rien, même aux appareils activés."
        >
          Me prévenir du briefing du matin, d’une séance adaptée et des séances importées.
        </SettingSwitch>

        <div className="border-t border-text-muted/10 pt-3 space-y-2">
          <p className="text-xs font-sans uppercase tracking-wider text-text-muted">Cet appareil</p>
          {hint ? (
            <p className="text-sm text-text-secondary">{hint}</p>
          ) : vapid && !vapidKey ? (
            <p className="text-sm text-text-secondary">
              Le serveur n’a pas de clés Web Push (VAPID) configurées.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {state === 'subscribed' ? (
                <>
                  <span className="text-sm text-success-green">Activées sur cet appareil.</span>
                  <Button variant="outline" size="sm" loading={busy} onClick={() => runDevice(unsubscribeDevice)}>
                    Désactiver
                  </Button>
                  <Button variant="ghost" size="sm" loading={test.isPending} onClick={() => test.mutate()}>
                    Envoyer un test
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  loading={busy}
                  disabled={!state || !vapidKey}
                  onClick={() => vapidKey && runDevice(() => subscribeDevice(vapidKey))}
                >
                  Activer sur cet appareil
                </Button>
              )}
            </div>
          )}
          {deviceError && <p className="text-xs text-danger-red">{deviceError}</p>}
          {test.isError && <p className="text-xs text-danger-red">Test impossible.</p>}
          {testResult && <p className="text-xs text-text-muted">{testResult}</p>}
        </div>
      </div>
    </Panel>
  );
}

/**
 * Settings tab for the coach: whether it writes a daily briefing, adapts and
 * sends today's session and notifies this device, plus the memory ledger it
 * keeps (data/agent/memory/*.md), read-only, via GET /api/agent/memory.
 */
export function CoachTab({ settings, updateSetting }: SettingsTabProps) {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['agentMemory'],
    queryFn: async (): Promise<LedgerResponse> => {
      const response = await authFetch('/api/agent/memory');
      if (!response.ok) throw new Error(`API Error ${response.status}`);
      return response.json();
    },
    staleTime: 10_000,
  });


  const briefingSwitch = (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Sunrise className="size-4 text-neon-gold" /> Briefing du matin
        </span>
      }
    >
      <SettingSwitch
        checked={settings.coach_briefing_enabled}
        onChange={(value) => updateSetting('coach_briefing_enabled', value)}
        hint="Décoché, le Dashboard garde le conseil calculé par les règles."
      >
        Après la synchronisation du matin, le coach lit tes données et écrit deux ou trois
        phrases sur ton tableau de bord.
      </SettingSwitch>
    </Panel>
  );

  return (
    <div className="space-y-4">
      {briefingSwitch}
      <AdaptationPanel settings={settings} updateSetting={updateSetting} />
      <NotificationsPanel settings={settings} updateSetting={updateSetting} />
      <AthleteFactsPanel />
      <details>
      <summary className="min-h-11 cursor-pointer text-sm text-text-muted">Consulter le journal du coach</summary>
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-muted">
          Journal du coach : observations et décisions, distinctes de tes déclarations.
        </p>
        <Button variant="ghost" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`size-4 ${isRefetching ? 'animate-spin' : ''}`} /> Rafraîchir
        </Button>
      </div>

      {isLoading && <p className="text-sm text-text-muted">Chargement du journal…</p>}
      {isError && (
        <Panel title="Mémoire du coach">
          <p className="text-sm text-danger-red">Ledger indisponible (backend à jour ?).</p>
          <Button variant="ghost" onClick={() => refetch()} className="mt-2">
            <RefreshCw className="size-4" /> Réessayer
          </Button>
        </Panel>
      )}

      {(data?.files ?? []).map((file) => {
        const meta = FILE_META[file.name] ?? { label: file.name, icon: BookOpen, hint: '' };
        const Icon = meta.icon;
        return (
          <Panel
            key={file.name}
            title={
              <span className="flex items-center gap-2">
                <Icon className="size-4 text-neon-cyan" /> {meta.label}
                <code className="text-xs text-text-muted">{file.name}</code>
              </span>
            }
          >
            {meta.hint && <p className="text-xs text-text-muted mb-2">{meta.hint}</p>}
            {file.content.trim() ? (
              <pre className="text-xs whitespace-pre-wrap bg-abyss/50 rounded p-3 max-h-96 overflow-y-auto border border-text-muted/10">
                {file.content}
              </pre>
            ) : (
              <p className="text-sm text-text-muted italic">
                Vide — discute d'une séance avec le coach pour remplir le journal.
              </p>
            )}
          </Panel>
        );
      })}
      </details>
    </div>
  );
}
