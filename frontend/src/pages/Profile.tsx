import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Diamond, Lock, Trophy } from 'lucide-react';
import { Button, Modal, ModalHeader } from '@/components/ui';
import { settingsApi, strengthApi } from '@/lib/api';
import {
  characterAsset,
  classes,
  gameApi,
  ranks,
  useGamePreference,
  useGameSnapshot,
  type Player,
  type Skin,
} from '@/lib/gamification';
import { RecordSource } from './RecordSource';
import { StrengthRecords } from './profileRecords';
import { RecordsCard } from './analytics/cards/RecordsCard';
import { RecentSessions } from './log/RecentSessions';

const tabs = [
  ['overview', 'Vue', 'Vue d’ensemble'],
  ['achievements', 'Succès', 'Succès'],
  ['records', 'Records', 'Records'],
  ['history', 'Sorties', 'Sorties'],
  ['collection', 'Skins', 'Collection'],
] as const;
const number = (n: number) => n.toLocaleString('fr-FR');

export function ProfilePage() {
  const pref = useGamePreference();
  if (pref.isPending)
    return (
      <p className="p-6" role="status">
        Chargement du profil…
      </p>
    );
  if (pref.error)
    return (
      <p className="p-6" role="alert">
        {pref.error.message}
      </p>
    );
  if (!pref.data?.enabled)
    return (
      <div className="page-shell space-y-4">
        <h1 className="page-title">Mon profil</h1>
        <p>
          Active la gamification pour retrouver ton personnage, tes succès et
          tes tenues.
        </p>
        <Link className="text-neon-cyan" to="/settings?tab=gamification">
          Ouvrir les Réglages →
        </Link>
      </div>
    );
  return <ActiveProfile />;
}

function ActiveProfile() {
  const [params, setParams] = useSearchParams();
  const tab = tabs.find((t) => t[0] === params.get('tab'))?.[0] ?? 'overview';
  const client = useQueryClient();
  // A read: pending evidence asks for one projection, never retried.
  const player = useGameSnapshot({ refetchOnWindowFocus: 'always' });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  });
  const [recordSource, setRecordSource] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  if (player.isPending)
    return (
      <p role="status" className="p-6">
        Chargement de la progression…
      </p>
    );
  if (player.error)
    return (
      <div className="p-6" role="alert">
        Progression indisponible : {player.error.message}{' '}
        <Button onClick={() => player.refetch()}>Actualiser</Button>
      </div>
    );
  const p = player.data;
  if (!p.enabled)
    return (
      <Link
        className="block p-6 text-neon-cyan"
        to="/settings?tab=gamification"
      >
        Gamification désactivée · Réglages →
      </Link>
    );
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['game'] });
    client.invalidateQueries({ queryKey: ['game-preference'] });
  };
  return (
    <div className="page-shell space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="page-title">Mon profil</h1>
        <Link
          className="font-sans text-xs text-neon-cyan py-3"
          to="/settings?tab=gamification"
        >
          Réglages →
        </Link>
      </header>
      {player.syncError && (
        <p role="alert" className="font-sans text-xs text-warning-orange">
          Progression non actualisée : {player.syncError.message}{' '}
          <Button variant="ghost" onClick={player.sync}>
            Actualiser
          </Button>
        </p>
      )}
      <div className="flex items-center gap-3 sm:gap-6">
        <button
          className="shrink-0"
          aria-label="Personnaliser mon personnage"
          onClick={() => setEditing(true)}
        >
          <img
            src={characterAsset(p.athlete_class, p.equipped, p.level)}
            alt="Personnage équipé"
            className="size-20 sm:size-28 object-contain"
          />
        </button>
        <div className="min-w-0 flex-1 font-sans space-y-2">
          <p className="text-xs sm:text-sm text-neon-cyan uppercase break-words">
            {settings.data?.display_name ?? 'Athlète'} /{' '}
            {classes.find((c) => c.id === p.athlete_class)?.name}
          </p>
          <h2 className="text-lg sm:text-2xl font-bold text-neon-gold">
            Niveau {p.level} · {p.rank}
          </h2>
          <p className="text-[10px] sm:text-xs text-text-secondary">
            {number(p.xp)} XP ·{' '}
            {p.level_span
              ? `${number(p.in_level)} / ${number(p.level_span)} vers le niv. ${p.level + 1}`
              : 'Rang Légende atteint'}
          </p>
          <progress
            aria-label="Progression du niveau"
            max={p.level_span ?? 1}
            value={p.level_span ? p.in_level : 1}
            className="w-full h-1.5 accent-neon-purple"
          />
        </div>
      </div>
      <div className="flex items-center gap-4 sm:gap-20 font-sans">
        <span className="flex items-center gap-2 text-neon-gold font-bold">
          <Diamond size={16} />
          {number(p.shards)}
          <span className="sr-only">Éclats</span>
        </span>
        <span className="text-xs text-text-secondary">
          {p.sessions} séances
        </span>
        <span className="text-xs text-text-secondary">
          {p.badges.filter((b) => b.unlocked).length} succès / 4
        </span>
      </div>
      {p.pending > 0 && (
        <p role="status" className="text-sm text-warning-orange">
          {p.pending} preuves en attente.{' '}
          <button className="underline" onClick={() => player.refetch()}>
            Continuer la synchronisation
          </button>
        </p>
      )}
      {p.shards < 0 && (
        <p role="status" className="text-sm text-warning-orange">
          Correction de doublon : les prochains Éclats compenseront ce solde.
          Tes tenues restent acquises.
        </p>
      )}
      <nav
        aria-label="Onglets du profil"
        className="flex border-b border-text-muted/20 gap-1 sm:gap-2 pb-5 font-sans text-[11px] sm:text-xs"
      >
        {tabs.map(([id, short, long]) => (
          <Link
            key={id}
            to={id === 'overview' ? '/profile' : `/profile?tab=${id}`}
            aria-current={tab === id ? 'page' : undefined}
            className="rpg-tab min-h-11 flex-1 sm:flex-none px-1 sm:px-4 rounded flex items-center justify-center text-text-secondary"
          >
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{long}</span>
          </Link>
        ))}
      </nav>
      {tab === 'overview' && (
        <>
          <section className="rpg-surface p-4 font-sans space-y-3">
            <p className="text-xs text-text-muted">CETTE SEMAINE</p>
            <h3 className="text-lg font-bold text-neon-cyan">
              {p.week.complete
                ? 'Objectif respecté'
                : `${p.week.sessions} séances sur ${p.week.goal}`}
            </h3>
            <p className="text-sm text-neon-gold">
              {Math.min(p.week.sessions, 6) * 50 + (p.week.complete ? 200 : 0)}{' '}
              XP ·{' '}
              {Math.min(p.week.sessions, 6) * 10 + (p.week.complete ? 40 : 0)}{' '}
              Éclats gagnés
            </p>
            <p className="text-xs text-text-secondary">
              Le repos prescrit fait partie de l’objectif adapté. La
              récupération reste indépendante de ton niveau.
            </p>
          </section>
          <h3 className="text-xs font-sans text-text-muted">
            DERNIERS ACCOMPLISSEMENTS
          </h3>
          {!p.history.length && (
            <p className="text-sm text-text-secondary">
              Ta première séance enregistrée après activation lancera
              l’aventure.
            </p>
          )}
          <Receipts player={p} compact />
          <button
            onClick={() => setParams({ tab: 'achievements' })}
            className="text-neon-cyan text-xs font-sans min-h-11"
          >
            Voir tous mes succès →
          </button>
        </>
      )}
      {tab === 'achievements' && (
        <>
          <h3 className="font-bold text-lg">Mes accomplissements</h3>
          <div className="divide-y divide-text-muted/15">
            {p.badges.map((b) => (
              <div key={b.sessions} className="flex items-center gap-4 py-4">
                <Trophy
                  className={b.unlocked ? 'text-neon-gold' : 'text-text-muted'}
                  size={24}
                />
                <div className="flex-1">
                  <p className="font-sans text-sm">
                    {b.sessions} séances accomplies
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    {b.unlocked
                      ? 'Succès acquis'
                      : `${p.sessions} / ${b.sessions} séances`}
                  </p>
                </div>
                {!b.unlocked && <Lock size={16} />}
              </div>
            ))}
          </div>
          <h3 className="font-bold text-lg">Les six rangs</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {ranks.map((r) => (
              <div
                key={r.level}
                className="rpg-surface p-3 flex items-center gap-2"
              >
                <img
                  alt=""
                  src={characterAsset(p.athlete_class, 'base', r.level)}
                  className="size-16 object-contain"
                />
                <div>
                  <p className="font-sans text-xs text-neon-gold">{r.name}</p>
                  <p className="text-xs text-text-muted">Niveau {r.level}</p>
                  <p className="text-[10px] text-text-muted">
                    {p.level >= r.level
                      ? 'Débloqué'
                      : `${number(50 * r.level * (r.level - 1))} XP`}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-muted">
            Les titres attestent tes accomplissements, pas une capacité
            physiologique.
          </p>
          <Receipts player={p} />
        </>
      )}
      {tab === 'records' && (
        <>
          <RecordsCard onOpen={setRecordSource} />
          <p className="text-xs text-text-muted">
            Records mesurés, sans multiplicateur d’XP. La fréquence cardiaque
            absente reste non mesurée.
          </p>
          <StrengthRecords />
        </>
      )}
      {tab === 'history' && <ActivityHistory />}
      {tab === 'collection' && <Collection player={p} refresh={refresh} />}
      {recordSource !== null && (
        <RecordSource id={recordSource} close={() => setRecordSource(null)} />
      )}
      {editing && (
        <CharacterEditor
          player={p}
          close={() => setEditing(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function Receipts({
  player,
  compact = false,
}: {
  player: Player;
  compact?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const older = useQuery({
    queryKey: ['game', 'receipts', offset],
    queryFn: () => gameApi.snapshot(offset),
    enabled: offset > 0,
  });
  const data = offset ? older.data : player;
  return (
    <div className="font-sans">
      {older.error && (
        <p role="alert" className="text-danger-red">
          {older.error.message}
        </p>
      )}
      {(data?.history ?? []).slice(0, compact ? 3 : 50).map((r) => (
        <div
          key={r.id}
          className="flex gap-3 justify-between border-b border-text-muted/15 py-4 text-sm"
        >
          <div className="min-w-0">
            <p>{r.label}</p>
            <p className="text-[11px] text-text-muted mt-1">
              {new Date(r.created_at).toLocaleDateString('fr-FR')} · reçu
              enregistré
            </p>
          </div>
          <span className="text-neon-gold shrink-0 text-right text-xs">
            {r.xp !== 0 && (
              <>
                {r.xp > 0 ? '+' : ''}
                {r.xp} XP
                <br />
              </>
            )}
            {r.shards > 0 ? '+' : ''}
            {r.shards} Éclats
          </span>
        </div>
      ))}
      {!compact && (
        <div className="flex gap-3 py-3">
          {offset > 0 && (
            <Button onClick={() => setOffset(offset - 50)}>Précédent</Button>
          )}
          {data?.has_more && (
            <Button onClick={() => setOffset(offset + 50)}>Suivant</Button>
          )}
        </div>
      )}
    </div>
  );
}

function Collection({
  player: p,
  refresh,
}: {
  player: Player;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState<Skin | null>(null);
  const [purchaseKey, setPurchaseKey] = useState(() => crypto.randomUUID());
  const buy = useMutation({ mutationFn: gameApi.purchase, onSuccess: refresh });
  const equip = useMutation({
    mutationFn: gameApi.equip,
    onSuccess: () => {
      refresh();
      setSelected(null);
    },
  });
  const selectedSkin = p.catalog.find((s) => s.id === selected?.id);
  return (
    <>
      <p className="text-sm text-text-secondary">
        Des tenues cosmétiques pour ton personnage. Les achats ne changent pas
        tes performances.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {p.catalog.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setSelected(s);
              setPurchaseKey(crypto.randomUUID());
              buy.reset();
              equip.reset();
            }}
            className="rpg-surface p-3 text-left space-y-2"
          >
            <img
              src={characterAsset(p.athlete_class, s.id, p.level)}
              alt={s.name}
              className="w-full aspect-square object-contain"
            />
            <p className="font-sans text-sm">{s.name}</p>
            <p className="text-xs text-neon-gold">
              {p.equipped === s.id
                ? 'Équipée'
                : s.owned
                  ? 'Possédée'
                  : s.price
                    ? `${s.price} Éclats`
                    : `Niveau ${s.level} · gratuit`}
            </p>
          </button>
        ))}
      </div>
      {selectedSkin && (
        <Modal
          open
          onClose={() => {
            if (!buy.isPending && !equip.isPending) setSelected(null);
          }}
          label="Tenue du personnage"
        >
          <ModalHeader
            title={selectedSkin.name}
            onClose={() => setSelected(null)}
          />
          <img
            src={characterAsset(p.athlete_class, selectedSkin.id, p.level)}
            alt="Aperçu de la tenue"
            className="size-48 mx-auto object-contain"
          />
          <p className="text-sm text-text-secondary my-4">
            Solde : {number(p.shards)} Éclats
            {!selectedSkin.owned && ` · Prix : ${selectedSkin.price} Éclats`}
          </p>
          {(buy.error || equip.error) && (
            <p role="alert" className="text-danger-red text-sm mb-4">
              {buy.error?.message ?? equip.error?.message} En cas
              d’interruption, actualise pour vérifier l’achat avant de le
              relancer.
            </p>
          )}
          {buy.isSuccess && (
            <p role="status" className="text-success-green text-sm my-3">
              Tenue acquise. Tu peux maintenant l’équiper.
            </p>
          )}
          {selectedSkin.owned ? (
            <Button
              fullWidth
              className="min-h-11"
              disabled={equip.isPending}
              onClick={() =>
                equip.mutate({ skin: selectedSkin.id, version: p.version })
              }
            >
              Équiper gratuitement
            </Button>
          ) : (
            <Button
              fullWidth
              className="min-h-11"
              disabled={
                buy.isPending ||
                p.shards < selectedSkin.price ||
                p.level < selectedSkin.level
              }
              onClick={() =>
                buy.mutate({
                  key: purchaseKey,
                  skin: selectedSkin.id,
                  expected_price: selectedSkin.price,
                })
              }
            >
              {p.level < selectedSkin.level
                ? `Débloquée au niveau ${selectedSkin.level}`
                : p.shards < selectedSkin.price
                  ? 'Solde insuffisant'
                  : `Confirmer · ${selectedSkin.price} Éclats`}
            </Button>
          )}
          <Button variant="ghost" className="mt-3" onClick={refresh}>
            Actualiser le solde et la propriété
          </Button>
        </Modal>
      )}
    </>
  );
}

function CharacterEditor({
  player: p,
  close,
  refresh,
}: {
  player: Player;
  close: () => void;
  refresh: () => void;
}) {
  const [selected, setSelected] = useState(p.athlete_class);
  const save = useMutation({
    mutationFn: gameApi.appearance,
    onSuccess: () => {
      refresh();
      close();
    },
  });
  return (
    <Modal open onClose={close} label="Personnaliser mon personnage">
      <ModalHeader title="Ma classe" onClose={close} />
      <p className="text-sm text-text-secondary mb-4">
        Choisis ton approche sportive. Changer de classe conserve tes gains.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {classes.map((c) => (
          <button
            key={c.id}
            aria-pressed={c.id === selected}
            onClick={() => setSelected(c.id)}
            className={`rpg-surface p-3 ${c.id === selected ? 'ring-1 ring-neon-cyan' : ''}`}
          >
            <img
              alt=""
              src={characterAsset(c.id, p.equipped, p.level)}
              className="size-24 mx-auto"
            />
            <p className="font-sans text-sm">{c.name}</p>
            <p className="text-xs text-text-muted">{c.detail}</p>
          </button>
        ))}
      </div>
      {save.error && (
        <p role="alert" className="text-danger-red my-3">
          {save.error.message}
        </p>
      )}
      <Button
        className="mt-5 min-h-11"
        fullWidth
        disabled={save.isPending}
        onClick={() =>
          save.mutate({
            athlete_class: selected,
            silhouette: p.silhouette,
            version: p.version,
          })
        }
      >
        Enregistrer mon personnage
      </Button>
    </Modal>
  );
}

function ActivityHistory() {
  const sessions = useQuery({
    queryKey: ['strengthSessions'],
    queryFn: () => strengthApi.getSessions(50),
  });
  return (
    <div className="space-y-5">
      <h3 className="font-bold">Mes sorties et séances</h3>
      <RecentSessions />
      <h3 className="font-bold">Force</h3>
      {sessions.error && <p role="alert">Séances indisponibles.</p>}
      {sessions.data?.map((s) => (
        <Link
          to={`/log?session=${s.id}`}
          key={s.id}
          className="flex justify-between gap-3 border-b border-text-muted/15 py-3 font-sans text-xs"
        >
          <span>
            {s.name ?? 'Force'}
            <span className="block text-text-muted mt-1">{s.date}</span>
          </span>
          <span className="text-neon-cyan">Voir la séance →</span>
        </Link>
      ))}
    </div>
  );
}
