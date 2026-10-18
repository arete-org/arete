import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, Pencil, Save } from 'lucide-react';
import { cn, formatDurationCompact } from '@/lib/utils';
import { EmptyState, ErrorState, LoadingState } from '@/components';
import { PushOffer } from '@/components/PushOffer';
import { Button, Panel, RPE_TEXT, RpeBadge, Textarea, rpeTone } from '@/components/ui';
import { analyticsApi } from '@/lib/api';
import { qk, strengthSessionsQuery } from '@/lib/queryKeys';
import { getSportColor, getSportIconComponent } from '@/lib/sport';
import type { CardioSession } from '@/types';

const SOURCE_BADGE: Record<string, string> = {
  strava: 'bg-strava/20 text-strava',
  garmin: 'bg-info-blue/20 text-info-blue',
  manual: 'bg-text-muted/20 text-text-muted',
};

/** Recent cardio sessions with inline RPE/notes editing. */
export function RecentSessions() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.cardioSessions,
    queryFn: () => analyticsApi.getSessions(20),
  });
  // A Garmin activity linked to a Muscu log is shown once, as that log (Force tab).
  const { data: strength } = useQuery(strengthSessionsQuery);
  const linked = new Set((strength ?? []).map((l) => l.garmin_activity_id));

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRpe, setEditRpe] = useState<number | null>(null);
  const [editNotes, setEditNotes] = useState('');

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { rpe?: number | null; notes?: string } }) =>
      analyticsApi.updateSession(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk.cardioSessions });
      setEditingId(null);
    },
  });

  const startEdit = (session: CardioSession) => {
    setEditingId(session.id);
    setEditRpe(session.rpe);
    setEditNotes(session.notes || '');
  };

  const saveEdit = () => {
    if (editingId === null) return;
    updateMutation.mutate({
      id: editingId,
      // null clears the RPE; undefined would vanish from the JSON body.
      data: { rpe: editRpe, notes: editNotes },
    });
  };

  if (isLoading) return <LoadingState message="CHARGEMENT DES SÉANCES…" />;
  if (isError) return <ErrorState message="ÉCHEC DU CHARGEMENT DES SÉANCES" onRetry={() => refetch()} />;

  const sessions = (data?.sessions || []).filter((s) => !linked.has(s.id));
  if (sessions.length === 0) {
    return (
      <Panel animate={false}>
        <EmptyState message="AUCUNE SÉANCE CARDIO" action="Importe un fichier FIT, saisis-la sans montre ou synchronise Strava" />
      </Panel>
    );
  }

  return (
    <Panel title="SÉANCES RÉCENTES" delay={0.1}>
      <div className="space-y-2">
        <PushOffer moment="session" />
        {sessions.map((s) => {
          const Icon = getSportIconComponent(s.sport);
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className="p-3 bg-abyss rounded border border-text-muted/10 hover:border-neon-cyan/20 transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Icon size="md" className={getSportColor(s.sport)} />
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`/log/sessions/${s.id}`}
                      className="flex items-center gap-2 group"
                      title="Voir le détail de la séance"
                    >
                      <span className="text-sm font-sans text-text-muted">{s.date}</span>
                      <span className="text-sm font-sans text-text-primary truncate group-hover:text-neon-cyan group-hover:underline">
                        {s.name || 'Sans titre'}
                      </span>
                      <ChevronRight className="w-4 h-4 shrink-0 text-text-muted group-hover:text-neon-cyan" />
                    </Link>
                    <div className="text-xs font-sans text-text-muted mt-0.5 flex flex-wrap gap-x-3">
                      <span>{formatDurationCompact(s.duration_sec)}</span>
                      {s.distance_m && <span>{(s.distance_m / 1000).toFixed(1)} km</span>}
                      {s.avg_hr && <span>{s.avg_hr} bpm</span>}
                      {s.pace_display && <span>{s.pace_display} /km</span>}
                      {s.calories && <span>{s.calories} kcal</span>}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-2 shrink-0">
                  {s.source && (
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-sans uppercase',
                        SOURCE_BADGE[s.source] ?? SOURCE_BADGE.manual
                      )}
                    >
                      {s.source}
                    </span>
                  )}
                  {!editing && <RpeBadge rpe={s.rpe} showEmpty />}
                  <button
                    type="button"
                    onClick={() => (editing ? saveEdit() : startEdit(s))}
                    disabled={updateMutation.isPending}
                    className="p-1 hover:bg-text-muted/20 rounded transition-colors text-text-muted hover:text-neon-cyan"
                    title={editing ? 'Enregistrer' : 'Modifier RPE et notes'}
                  >
                    {editing ? <Save className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {editing && (
                <div className="mt-3 pt-3 border-t border-text-muted/10 space-y-3 animate-fade-in">
                  <div>
                    <label className="text-xs font-sans text-text-muted uppercase block mb-1">RPE (1-10)</label>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={editRpe ?? 5}
                      onChange={(e) => setEditRpe(Number(e.target.value))}
                      className="w-full accent-neon-cyan"
                    />
                    <div className="flex justify-between items-center text-xs font-sans text-text-muted">
                      <span>1</span>
                      <span className={cn('text-sm font-bold', editRpe === null ? 'text-text-muted' : RPE_TEXT[rpeTone(editRpe)])}>
                        {editRpe ?? 'non renseigné'}
                      </span>
                      <span className="flex items-center gap-2">
                        10
                        {editRpe !== null && (
                          <button
                            type="button"
                            onClick={() => setEditRpe(null)}
                            className="text-neon-cyan hover:underline"
                          >
                            effacer
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-sans text-text-muted uppercase block mb-1">Notes</label>
                    <Textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      rows={2}
                      placeholder="Sensations ?"
                      className="bg-void px-3"
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      ANNULER
                    </Button>
                    <Button size="sm" strong onClick={saveEdit} loading={updateMutation.isPending}>
                      {updateMutation.isPending ? 'ENREGISTREMENT…' : 'ENREGISTRER'}
                    </Button>
                  </div>
                </div>
              )}

              {!editing && s.notes && (
                <div className="mt-2 text-xs font-sans text-text-muted italic">{s.notes}</div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
