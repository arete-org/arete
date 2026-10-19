import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IosInstallSteps } from '@/components/InstallPrompt';
import { notificationsApi, settingsApi, type NotificationKind, type UserSettings } from '@/lib/api';
import { onPushOffersQuiet, pushOfferKey, pushOffersQuiet, quietPushOffers, readFlag, writeFlag, type PushMoment } from '@/lib/install';
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

/**
 * Before the offer leaves, the focus it holds goes to the nearest visible control
 * outside it (before, else after), never to the page; a focus elsewhere stays.
 */
function focusNear(root: HTMLElement) {
  if (!root.contains(document.activeElement)) return;
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    element => !root.contains(element) && element.getClientRects().length > 0,
  );
  const before = all.filter(element => root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING).pop();
  const after = all.find(element => root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  (before ?? after)?.focus({ preventScroll: true });
}

function broadcastPreferences() {
  if (typeof BroadcastChannel === 'undefined') return;
  // Other tabs re-read their settings rather than save a copy without this change (SettingsProvider).
  const channel = new BroadcastChannel('arete-preferences');
  channel.postMessage('refresh');
  channel.close();
}

/**
 * The moment's ritual turns on with the device: the master switch and its kind,
 * only when either was off. `PUT /settings` replaces the whole record, so it is
 * read fresh first rather than taken from a cache another tab may have outdated.
 */
async function enableRitual(queryClient: ReturnType<typeof useQueryClient>, kind: NotificationKind) {
  const settings = await queryClient.fetchQuery<UserSettings>({ queryKey: qk.settings, queryFn: settingsApi.get, staleTime: 0 });
  const prefs = settings.notification_preferences;
  if (settings.notifications_enabled && prefs.kinds[kind]) return;
  const { user_id, ...rest } = settings;
  const saved = await settingsApi.update({
    ...rest,
    notifications_enabled: true,
    notification_preferences: { ...prefs, kinds: { ...prefs.kinds, [kind]: true } },
  });
  queryClient.setQueryData(qk.settings, saved);
  broadcastPreferences();
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
  // Answered on this device, or another offer put off in this session: nothing to ask.
  const [answer, setAnswer] = useState<'open' | 'enabled' | 'closed'>(() => (readFlag(pushOfferKey(moment)) || pushOffersQuiet() ? 'closed' : 'open'));
  const [ritualSaved, setRitualSaved] = useState(true);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  // Another offer or the first-launch modal answered meanwhile: this one steps back too.
  const quiet = useSyncExternalStore(onPushOffersQuiet, pushOffersQuiet, () => false);
  const open = answer === 'open' && !quiet;
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
        {ritualSaved
          ? 'Notifications activées sur cet appareil. Tu choisis quoi recevoir dans Réglages → Coach.'
          : 'Notifications activées sur cet appareil, mais ce réglage n’a pas pu être enregistré : active-les dans Réglages → Coach.'}
      </p>
    );
  }
  const ios = state === 'ios-not-installed';
  if (!open || !(ios || (state === 'unsubscribed' && vapidKey))) return null;

  const close = () => {
    writeFlag(pushOfferKey(moment), 'dismissed');
    quietPushOffers();
    if (root.current) focusNear(root.current);
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
      if (next !== 'subscribed') {
        // Only the browser's explicit refusal is an answer; a prompt closed
        // without choosing, or a worker gone meanwhile, may ask again later,
        // but not in this session.
        if (next === 'denied') writeFlag(pushOfferKey(moment), 'declined');
        if (next === 'unsubscribed') quietPushOffers();
        if (root.current) focusNear(root.current);
        setAnswer('closed');
        return;
      }
      writeFlag(pushOfferKey(moment), 'enabled');
      setAnswer('enabled');
      try {
        await enableRitual(queryClient, kind);
      } catch {
        // The device rings; the athlete is told to turn the kind on by hand.
        setRitualSaved(false);
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
