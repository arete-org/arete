import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { automationApi, inboxKey } from '@/lib/automations';
import { readableError } from '@/lib/utils';
import { useCoachWords } from '@/lib/coachName';

export function InboxBell({ className = '' }: { className?: string }) {
  const query = useQuery({ queryKey: [...inboxKey, 'todo', 0], queryFn: () => automationApi.inbox(), refetchInterval: 60000 });
  const count = query.data?.unread ?? 0;
  return <Link to="/follow-up" className={`relative inline-flex min-h-11 min-w-11 items-center justify-center ${className}`} aria-label={`Suivi${count ? `, ${count} non lus` : ''}`}><Bell size={20} />{count > 0 && <span className="absolute right-0 top-0 rounded-full bg-text-primary text-void min-w-4 px-1 text-center text-[10px]">{count}</span>}</Link>;
}

/** Dashboard and inbox project the same server records and query cache. */
export function InboxPriority() {
  const coach = useCoachWords();
  const query = useQuery({ queryKey: [...inboxKey, 'todo', 0], queryFn: () => automationApi.inbox() });
  if (!query.data?.items.length) return null;
  return <section className="space-y-3" aria-label="Suivis prioritaires"><h2 className="font-display text-2xl">À suivre avec {coach.the}</h2>{query.data.items.slice(0, 3).map(item => <Link key={item.id} to={item.url} className="block border-b border-border py-4"><strong>{item.title}</strong><p className="text-sm text-text-secondary">{item.body}</p></Link>)}<Link className="underline" to="/follow-up">Tout le suivi</Link></section>;
}

export function NoticeActions({ id, read, archived }: { id: string; read: boolean; archived: boolean }) {
  const client = useQueryClient();
  const action = useMutation({ mutationFn: (change: { read?: boolean; archived?: boolean }) => automationApi.mark(id, change), onSuccess: () => client.invalidateQueries({ queryKey: inboxKey }) });
  return <><details className="suivi-menu"><summary aria-label="Options du suivi">•••</summary><div className="suivi-menu-content"><button disabled={action.isPending} onClick={() => action.mutate({ read: !read })}>{read ? 'Marquer non lu' : 'Marquer lu'}</button><button disabled={action.isPending} onClick={() => action.mutate({ archived: !archived })}>{archived ? 'Désarchiver' : 'Archiver'}</button></div></details>{action.error && <p role="alert">{readableError(action.error)}</p>}</>;
}
