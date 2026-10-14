import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Period } from '@/types';
import { analyticsApi } from '@/lib/api';
import { CHART, COLORS } from '@/lib/chartTheme';
import {
  CadenceCard,
  DescentCard,
  EfficiencyCard,
  ElevationCard,
  LoadCard,
  PaceCard,
  PeriodSelector,
  PREVIOUS_LABEL,
  RecordsCard,
  RecoveryCard,
  SECTIONS,
  Section,
  SectionNav,
  SportsCard,
  VamCard,
  VolumeCard,
  ZonesCard,
} from './analytics/index';

/** Highlight the section currently on screen. */
function useActiveSection(): string {
  const [active, setActive] = useState(SECTIONS[0].id);
  const observed = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observed.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActive(visible[0].target.id);
      },
      // Below the sticky banner, which covers the top quarter of the screen
      { rootMargin: '-30% 0px -60% 0px' }
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    observed.current = observer;
    return () => observer.disconnect();
  }, []);

  return active;
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState<Period>('30d');
  const active = useActiveSection();
  const banner = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['analytics', 'overview', period],
    queryFn: () => analyticsApi.getOverview(period),
    staleTime: 60 * 1000,
  });

  const cards = data?.cards;
  const bucket = data?.bucket ?? 'day';
  const previousLabel = PREVIOUS_LABEL[period];
  const state = { loading: isLoading, error: isError, bucket, previousLabel };

  /** Scroll a section just below the sticky banner, whatever its height. */
  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const b = banner.current;
    const offset = b ? parseFloat(getComputedStyle(b).top) + b.offsetHeight + 8 : 0;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
  };

  return (
    <div className="page-shell space-y-6">
      {/* Stays under the app's tab bar (57 px, desktop only) while the page scrolls */}
      <div
        ref={banner}
        className="sticky top-0 md:top-[57px] z-20 -mx-4 px-4 pt-3 space-y-3 bg-void/90 backdrop-blur border-b border-text-muted/10"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="page-title">Analyses</h1>
            {data && (
              <p className="text-xs text-text-muted font-sans mt-1">
                Du {new Date(`${data.start}T00:00:00`).toLocaleDateString('fr-FR')} au{' '}
                {new Date(`${data.end}T00:00:00`).toLocaleDateString('fr-FR')}
                {data.prev_start && ` · comparé ${previousLabel}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <PeriodSelector period={period} onChange={setPeriod} />
            <Link
              to="/analytics/bilan"
              className="px-3 py-1 text-xs font-sans uppercase tracking-wider rounded border border-neon-gold/30 text-neon-gold hover:bg-neon-gold/10"
            >
              Bilan annuel
            </Link>
          </div>
        </div>

        <SectionNav active={active} onJump={jump} />
      </div>

      <Section def={SECTIONS[0]}>
        <VolumeCard card={cards?.volume} {...state} />
        <LoadCard card={cards?.pmc} {...state} />
      </Section>

      <Section def={SECTIONS[1]}>
        <ZonesCard card={cards?.zones} model={data?.hr_zone_model} {...state} />
        <SportsCard card={cards?.sports} previousLabel={previousLabel} loading={isLoading} error={isError} />
      </Section>

      <Section def={SECTIONS[2]}>
        <EfficiencyCard card={cards?.decoupling} {...state} />
        <PaceCard card={cards?.pace} {...state} />
        <RecordsCard />
      </Section>

      <Section def={SECTIONS[3]}>
        <ElevationCard card={cards?.elevation} {...state} />
        <CadenceCard card={cards?.cadence} {...state} />
        <VamCard card={cards?.vam} previousLabel={previousLabel} loading={isLoading} error={isError} />
        <DescentCard card={cards?.descent} previousLabel={previousLabel} loading={isLoading} error={isError} />
      </Section>

      <Section def={SECTIONS[4]}>
        <RecoveryCard
          title="Préparation"
          question="La montre dit-elle que le corps est prêt ?"
          card={cards?.readiness}
          color={COLORS.neonCyan}
          unit="/100"
          {...state}
        />
        <RecoveryCard
          title="VFC"
          question="La variabilité cardiaque tient-elle la charge ?"
          card={cards?.hrv}
          color={CHART.purple}
          unit="ms"
          {...state}
        />
        <RecoveryCard
          title="Sommeil"
          question="Assez de sommeil pour encaisser ?"
          card={cards?.sleep}
          color={COLORS.infoBlue}
          unit=""
          {...state}
        />
        <RecoveryCard
          title="FC de repos"
          question="La fréquence de repos dérive-t-elle ?"
          card={cards?.resting_hr}
          color={CHART.red}
          unit="bpm"
          {...state}
        />
      </Section>
    </div>
  );
}
