import { Link } from 'react-router-dom';
import { characterAsset, useGamePreference, useGameSnapshot } from '@/lib/gamification';

export function PlayerSummary() {
  const pref = useGamePreference();
  const player = useGameSnapshot({ enabled: pref.data?.enabled === true });
  if (!pref.data?.enabled) return null;
  if (player.error)
    return (
      <p role="alert" className="text-xs text-warning-orange">
        Progression indisponible.{' '}
        <button className="underline" onClick={() => player.refetch()}>
          Actualiser
        </button>
      </p>
    );
  if (!player.data)
    return (
      <p role="status" className="text-xs text-text-muted">
        Chargement de la progression…
      </p>
    );
  const p = player.data;
  return (
    <Link
      to="/profile"
      className="flex min-w-0 items-center gap-3 border-b border-text-muted/20 py-3 font-sans"
    >
      <img
        src={characterAsset(p.athlete_class, p.equipped, p.level)}
        alt=""
        className="size-14 object-contain shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-neon-gold text-sm">
          Niveau {p.level} · {p.rank}
        </p>
        <p className="text-[11px] text-text-secondary">
          {p.xp.toLocaleString('fr-FR')} XP · {p.shards.toLocaleString('fr-FR')}{' '}
          Éclats
        </p>
        {p.history[0] && (
          <p className="text-[10px] text-text-muted truncate">
            Dernier reçu : {p.history[0].label}
          </p>
        )}
        {player.syncError && (
          <p role="alert" className="text-[10px] text-warning-orange truncate">
            Progression non actualisée : {player.syncError.message}
          </p>
        )}
      </div>
      <span className="text-xs text-neon-cyan">Profil →</span>
    </Link>
  );
}
