import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { documentRequest } from './documents';

export interface GamePreference {
  enabled: boolean;
  opted_in: boolean;
  available: boolean;
  version: number;
}
export interface Skin {
  id: string;
  name: string;
  price: number;
  level: number;
  owned: boolean;
}
export interface GameReceipt {
  id: string;
  cause: string;
  week: string | null;
  xp: number;
  shards: number;
  label: string;
  created_at: string;
}
export interface Player {
  enabled: boolean;
  available: boolean;
  version: number;
  athlete_class: string;
  silhouette: string;
  equipped: string;
  xp: number;
  shards: number;
  level: number;
  rank: string;
  in_level: number;
  level_span: number | null;
  sessions: number;
  pending: number;
  week: { sessions: number; goal: number; complete: boolean; timezone: string };
  catalog: Skin[];
  badges: { sessions: number; unlocked: boolean }[];
  history: GameReceipt[];
  has_more: boolean;
}
export const gameApi = {
  preference: () => documentRequest<GamePreference>('/settings/gamification'),
  toggle: (body: { enabled: boolean; version: number }) =>
    documentRequest<GamePreference>('/settings/gamification', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  snapshot: (offset = 0) =>
    documentRequest<Player>(`/gamification?offset=${offset}`),
  sync: () => documentRequest<Player>('/gamification/sync', { method: 'POST' }),
  purchase: (body: { key: string; skin: string; expected_price: number }) =>
    documentRequest<{ skin: string; charged: number }>(
      '/gamification/purchases',
      { method: 'POST', body: JSON.stringify(body) }
    ),
  equip: (body: { skin: string; version: number }) =>
    documentRequest<Player>('/gamification/equipment', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  appearance: (body: {
    athlete_class: string;
    silhouette: string;
    version: number;
  }) =>
    documentRequest<Player>('/gamification/appearance', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};
export const gameKey = ['game'] as const;
/** When a projection last failed: the read that follows it never asks for another. */
let lastFailure = 0;

/**
 * The stored progression: a read, so loading a page writes nothing. Evidence
 * settled nowhere yet (an import elsewhere) asks for one projection; neither
 * the projection's own answer nor the read after a failed one asks again.
 * `syncError` is that projection's failure, the snapshot still shown; `sync`
 * is the explicit retry a click offers.
 */
export function useGameSnapshot(options: { enabled?: boolean; refetchOnWindowFocus?: 'always' } = {}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: gameKey, queryFn: () => gameApi.snapshot(), retry: false, ...options });
  const asked = useRef(0);
  const { mutate, isPending, error: syncError } = useMutation({
    mutationFn: gameApi.sync,
    onSuccess: (player) => {
      asked.current = Date.now();
      client.setQueryData(gameKey, player, { updatedAt: asked.current });
    },
    onError: () => {
      lastFailure = Date.now();
    },
  });
  const { data, dataUpdatedAt } = query;
  useEffect(() => {
    if (!data?.enabled || !data.pending || isPending || asked.current >= dataUpdatedAt) return;
    const retry = lastFailure > asked.current;
    asked.current = dataUpdatedAt;
    if (!retry) mutate();
  }, [data, dataUpdatedAt, isPending, mutate]);
  // An explicit refresh (a click) may project again.
  return { ...query, syncError, sync: () => mutate() };
}

/** After a session event: the one projection, for an opted-in athlete only. */
export function syncGame(client: QueryClient) {
  if (!client.getQueryData<GamePreference>(['game-preference'])?.enabled) return;
  gameApi.sync().then(
    (player) => {
      client.setQueryData(gameKey, player);
      void client.invalidateQueries({ queryKey: [...gameKey, 'receipts'] });
    },
    // Never replayed: the snapshot is read again and shows what is pending.
    () => {
      lastFailure = Date.now();
      void client.invalidateQueries({ queryKey: gameKey });
    },
  );
}

export function useGamePreference() {
  return useQuery({
    queryKey: ['game-preference'],
    queryFn: gameApi.preference,
    retry: false,
    refetchOnWindowFocus: 'always',
  });
}
export const classes = [
  { id: 'scout', name: 'Éclaireur', detail: 'Endurance et constance' },
  { id: 'sentinel', name: 'Sentinelle', detail: 'Cardio et force' },
  { id: 'colossus', name: 'Colosse', detail: 'Force et équilibre' },
  { id: 'pioneer', name: 'Pionnier', detail: 'Reprise et habitudes' },
];
export const ranks = [
  { level: 1, name: 'Novice', asset: 'novice' },
  { level: 3, name: 'Initié', asset: 'initie' },
  { level: 6, name: 'Adepte', asset: 'adepte' },
  { level: 10, name: 'Expert', asset: 'expert' },
  { level: 15, name: 'Maître', asset: 'maitre' },
  { level: 20, name: 'Légende', asset: 'legende' },
];
const assets = import.meta.glob<string>('../assets/rpg/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});
export function characterAsset(athleteClass: string, skin = 'base', level = 1) {
  const rank =
    skin === 'cape'
      ? 'adepte'
      : skin === 'eclipse'
        ? 'expert'
        : skin === 'sovereign'
          ? 'maitre'
          : [...ranks].reverse().find((r) => level >= r.level)!.asset;
  return assets[`../assets/rpg/${athleteClass}-${rank}.svg`];
}
