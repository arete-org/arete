import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Period } from '@/types';
import { analyticsApi } from '@/lib/api';
import { CHART, COLORS } from '@/lib/chartTheme';
import { Button } from '@/components/ui';
import { PERIODS } from './analytics/types';
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
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const selected = params.get('period');
  const period: Period = PERIODS.find(value => value === selected) ?? '30d';
  const setPeriod = (value: Period) => setParams(current => {
    const next = new URLSearchParams(current);
    next.set('period', value);
    return next;
  });
  const active = useActiveSection();
  const banner = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError, refetch } = useQuery({
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
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  return (
    <div className="page-shell analytics-page">
      {/* Stays under the app's tab bar (57 px, desktop only) while the page scrolls */}
      <div
        ref={banner}
        className="analytics-banner"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-eyebrow">Arete / Analyses</p>
            <h1 className="page-title">Analyses</h1>
            {data && (
              <p className="text-xs text-text-muted font-sans mt-1">
                {new Date(`${data.start}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} –{' '}
                {new Date(`${data.end}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            )}
          </div>
            <Link
              to="/analytics/bilan"
              className="ui-button analytics-year-link"
            >
              Bilan annuel
            </Link>
        </div>
        <PeriodSelector period={period} onChange={setPeriod} />
        {data?.prev_start && data.prev_end && <p className="text-xs text-text-muted">
          Comparé au {new Date(`${data.prev_start}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} –{' '}
          {new Date(`${data.prev_end}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>}
        <SectionNav active={active} onJump={jump} />
      </div>
      {isError && <div role="alert" className="ui-inset p-4 flex flex-wrap items-center gap-3">
        <p>Les analyses n’ont pas pu être chargées.</p>
        <Button onClick={() => void refetch()}>Réessayer</Button>
      </div>}

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
        <RecordsCard onOpen={id => navigate(`/log/sessions/${id}`)} />
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
          unit="h"
          seconds
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
