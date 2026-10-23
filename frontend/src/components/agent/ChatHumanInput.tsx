import { useState } from 'react';
import { Button } from '@/components/ui';
import type { ChatMessage } from '@/lib/agentStream';
import type { HumanInterrupt } from '@/lib/humanInput';
import { readableError } from '@/lib/utils';
import { HumanInputCard } from './HumanInputCard';

export function ChatHumanInput({ message, busy, onDecision, onResume, onCancel }: {
  message: ChatMessage; busy: boolean;
  onDecision: (item: HumanInterrupt, decision: Record<string, unknown>) => Promise<unknown>;
  onResume: () => Promise<unknown>; onCancel: () => Promise<unknown>;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  if (!['waiting','ready'].includes(message.runState ?? '')) return null;
  const act = async (action: () => Promise<unknown>) => {
    setPending(true); setError('');
    try { await action(); } catch (err) { setError(readableError(err)); } finally { setPending(false); }
  };
  return <div className="mb-4 space-y-3">
    {message.interrupts?.map(item => <HumanInputCard key={item.id} item={item} onDecision={decision => onDecision(item, decision)} busy={busy || pending} />)}
    <div className="flex flex-wrap gap-2">
      {message.runState === 'ready' && <Button disabled={busy || pending} onClick={() => void act(onResume)}>Reprendre</Button>}
      <Button variant="ghost" disabled={busy || pending} onClick={() => void act(onCancel)}>Annuler cette demande</Button>
    </div>
    {error && <p role="alert" className="text-sm text-error-red">{error}</p>}
  </div>;
}
