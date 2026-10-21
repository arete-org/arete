import type { Bucket, Period } from '@/types';

export const PERIODS: Period[] = ['7d', '30d', '90d', '6m', '1y', 'all'];

export const PERIOD_LABEL: Record<Period, string> = {
  '7d': '7 jours',
  '30d': '30 jours',
  '90d': '90 jours',
  '6m': '6 mois',
  '1y': '1 an',
  all: 'Tout',
};

export const PERIOD_SHORT: Record<Period, string> = {
  '7d': '7 j',
  '30d': '30 j',
  '90d': '90 j',
  '6m': '6 mois',
  '1y': '1 an',
  all: 'Tout',
};

/** Names the previous window, article already contracted for "à". */
export const PREVIOUS_LABEL: Record<Period, string> = {
  '7d': 'aux 7 jours précédents',
  '30d': 'aux 30 jours précédents',
  '90d': 'aux 90 jours précédents',
  '6m': 'aux 6 mois précédents',
  '1y': "à l'année précédente",
  all: 'à la période précédente',
};

/** Axis label for a bucket start, adapted to the bucket width. */
export function formatBucket(iso: string, bucket: Bucket): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  if (bucket === 'month') return d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return bucket === 'week' ? `sem. ${day}` : day;
}

/** Full label used inside tooltips, where there is room. */
export function formatBucketLong(iso: string, bucket: Bucket): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  if (bucket === 'month') return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return bucket === 'week' ? `semaine du ${day}` : day;
}
