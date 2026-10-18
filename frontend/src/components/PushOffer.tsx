import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IosInstallSteps } from '@/components/InstallPrompt';
import { notificationsApi, settingsApi, type NotificationKind, type UserSettings } from '@/lib/api';
import { pushOfferKey, readFlag, writeFlag, type PushMoment } from '@/lib/install';
import { currentState, subscribeDevice } from '@/lib/push';
import { qk } from '@/lib/queryKeys';

const COPY: Record<PushMoment, { title: string; body: string; kind: NotificationKind }> = {
  session: {
    title: 'Reçois le retour du coach après chaque séance',
    body: 'Une notification dès que ta séance est analysée, sans rouvrir l’app.',
    kind: 'post_session',
  },
  briefing: {
    title: 'Reçois ton briefing chaque matin',
    body: 'Le briefing du jour arrive en notification, jamais pendant tes heures calmes.',
    kind: 'briefing',
  },
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The control before `root` in reading order, so a dismissal does not drop the focus to the page. */
function focusBefore(root: HTMLElement) {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = all.findIndex(element => root.contains(element));
  const target = all.slice(0, Math.max(first, 0)).reverse().find(element => element.getClientRects().length > 0);
  target?.focus({ preventScroll: true });
}

/**
 * The moment's ritual turns on with the device: the master switch and its kind,
 * only when either was off, from the settings the app shell already read.
 */
async function enableRitual(queryClient: ReturnType<typeof useQueryClient>, kind: NotificationKind) {
  const settings = queryClient.getQueryData<UserSettings>(qk.settings);
  if (!settings) return;
  const prefs = settings.notification_preferences;
  if (settings.notifications_enabled && prefs.kinds[kind]) return;
  const { user_id, ...rest } = settings;
  const saved = await settingsApi.update({
    ...rest,
    notifications_enabled: true,
    notification_preferences: { ...prefs, kinds: { ...prefs.kinds, [kind]: true } },
  });
  queryClient.setQueryData(qk.settings, saved);
}

/**
 * A contextual push opt-in, once per device and moment. Hidden where push cannot
 * work or already works; on iOS outside the installed app it leads to the
 * home-screen guide first. Permission is asked from the click only (Safari), and
 * nothing is requested from the server before the offer can actually show.
 */
export function PushOffer({ moment }: { moment: PushMoment }) {
  const queryClient = useQueryClient();
  const { title, body, kind } = COPY[moment];
  const [answer, setAnswer] = useState<'open' | 'enabled' | 'closed'>(() => (readFlag(pushOfferKey(moment)) ? 'closed' : 'open'));
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const open = answer === 'open';
  const { data: state } = useQuery({ queryKey: qk.pushState, queryFn: currentState, staleTime: Infinity, enabled: open });
  const { data: vapid } = useQuery({
    queryKey: qk.vapidKey,
    queryFn: notificationsApi.getVapidPublicKey,
    staleTime: Infinity,
    enabled: open && state === 'unsubscribed',
  });
  const vapidKey = vapid?.key ?? null;
  // The buttons leave with the answer: the confirmation takes the focus.
  useLayoutEffect(() => { if (answer === 'enabled') done.current?.focus({ preventScroll: true }); }, [answer]);

  if (answer === 'enabled') {
    return (
      <p ref={done} tabIndex={-1} role="status" className="push-offer text-xs text-success-green focus:outline-none">
        Notifications activées sur cet appareil. Tu choisis quoi recevoir dans Réglages → Coach.
      </p>
    );
  }
  const ios = state === 'ios-not-installed';
  if (!open || !(ios || (state === 'unsubscribed' && vapidKey))) return null;

  const close = () => {
    writeFlag(pushOfferKey(moment), 'dismissed');
    if (root.current) focusBefore(root.current);
    setAnswer('closed');
  };
  const enable = async () => {
    if (!vapidKey) return;
    setBusy(true);
    setError(null);
    try {
      // First thing in the click: Safari only prompts inside the gesture.
      const next = await subscribeDevice(vapidKey);
      queryClient.setQueryData(qk.pushState, next);
      // A refusal is an answer too: never asked again here.
      writeFlag(pushOfferKey(moment), next === 'subscribed' ? 'enabled' : 'declined');
      if (next !== 'subscribed') {
        if (root.current) focusBefore(root.current);
        setAnswer('closed');
        return;
      }
      setAnswer('enabled');
      try {
        await enableRitual(queryClient, kind);
      } catch {
        // The device rings; only the kind stays as it was, which Settings shows.
      }
    } catch {
      setError('Activation impossible : réessaie depuis Réglages → Coach.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={root} aria-label={title} className="push-offer ui-inset p-3 font-sans">
      <div className="flex items-start gap-3">
        <Bell aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-neon-cyan" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-sm text-text-primary">{title}</p>
            <p className="text-xs text-text-muted">
              {ios ? 'Sur iPhone et iPad, les notifications arrivent dans l’app installée sur l’écran d’accueil.' : body}
            </p>
          </div>
          {ios && guide && <IosInstallSteps />}
          {error && <p role="alert" className="text-xs text-danger-red">{error}</p>}
          <div className="flex flex-wrap gap-2">
            {ios ? (
              <Button size="sm" className="min-h-11" aria-expanded={guide} onClick={() => setGuide(!guide)}>
                Installer l’app d’abord
              </Button>
            ) : (
              <Button size="sm" className="min-h-11" loading={busy} onClick={() => void enable()}>
                Activer les notifications
              </Button>
            )}
            <Button size="sm" variant="ghost" className="min-h-11" disabled={busy} onClick={close}>
              Plus tard
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
