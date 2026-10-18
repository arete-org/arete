import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal, ModalHeader } from '@/components/ui/Modal';
import { notificationsApi } from '@/lib/api';
import { NOTIFICATIONS_OFFERED_KEY, quietPushOffers, readFlag, writeFlag } from '@/lib/install';
import { currentState, isStandalone, subscribeDevice } from '@/lib/push';
import { qk } from '@/lib/queryKeys';

const EXAMPLES = [
  { title: 'Briefing du coach', body: 'Forme en hausse : garde le seuil prévu, 3 × 10 min.' },
  { title: 'Séance analysée', body: 'Allure régulière sur la sortie longue, la fin était solide.' },
  { title: 'Bilan de la semaine', body: 'Semaine tenue à 92 %, deux ajustements proposés.' },
];

/**
 * On the first launch from the home screen, one screen offers notifications
 * with examples. Permission is only requested from the button (WebKit requires
 * a user gesture); either answer is remembered and the screen never returns.
 */
export function EnableNotifications() {
  const queryClient = useQueryClient();
  const [eligible] = useState(() => isStandalone() && !readFlag(NOTIFICATIONS_OFFERED_KEY));
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: state } = useQuery({ queryKey: qk.pushState, queryFn: currentState, staleTime: Infinity, enabled: eligible });
  const { data: vapid } = useQuery({ queryKey: qk.vapidKey, queryFn: notificationsApi.getVapidPublicKey, enabled: eligible });
  const vapidKey = vapid?.key ?? null;

  if (!eligible || state !== 'unsubscribed' || !vapidKey) return null;

  const close = () => {
    writeFlag(NOTIFICATIONS_OFFERED_KEY, '1');
    // Answered here: the contextual offers (PushOffer) do not ask again this session.
    quietPushOffers();
    setOpen(false);
  };
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(qk.pushState, await subscribeDevice(vapidKey));
      close();
    } catch {
      setError('Activation impossible : réessaie depuis Réglages → Coach.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} label="Active les notifications" className="max-w-md">
      <ModalHeader title="Active les notifications" icon={<Bell className="size-5" />} onClose={close} />
      <p className="mb-4 text-sm text-text-secondary">
        Le coach te prévient quand il a quelque chose pour toi. Tu choisis ensuite quoi recevoir dans
        Réglages → Coach, et rien n’arrive pendant tes heures calmes (21 h 30 – 7 h par défaut).
      </p>
      <ul className="mb-5 space-y-2" aria-label="Exemples de notifications">
        {EXAMPLES.map((example) => (
          <li key={example.title} className="rounded border border-text-muted/15 bg-abyss/60 p-3">
            <p className="text-xs font-sans text-text-primary">{example.title}</p>
            <p className="text-xs text-text-muted">{example.body}</p>
          </li>
        ))}
      </ul>
      {error && <p className="mb-3 text-xs text-danger-red">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={() => void enable()}>
          Activer les notifications
        </Button>
        <Button variant="ghost" onClick={close}>
          Plus tard
        </Button>
      </div>
    </Modal>
  );
}
