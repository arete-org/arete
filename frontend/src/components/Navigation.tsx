import { lazy, Suspense, type MouseEvent } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { BarChart3, CalendarDays, Dumbbell, LayoutDashboard, Settings } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '@/lib/api';
import { qk } from '@/lib/queryKeys';
import { useGamePreference } from '@/lib/gamification';
import { AreteMark, AreteWordmark } from './AreteBrand';
import { User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthState } from '@/components/auth/authState';

// Clerk's account menu lives in the lazily loaded auth chunk; it only renders when sign-in is on.
const AccountButton = lazy(() =>
  import('@/components/auth/ClerkGate').then((m) => ({
    default: m.AccountButton,
  })),
);

const navItems = [
  { path: '/', label: 'Tableau de bord', icon: LayoutDashboard },
  { path: '/planning', label: 'Planning', icon: CalendarDays },
  { path: '/analytics', label: 'Analyses', icon: BarChart3 },
  { path: '/log', label: 'Journal', icon: Dumbbell },
  { path: '/settings', label: 'Réglages', icon: Settings },
];

/**
 * Desktop: sticky top navbar
 * Mobile: fixed bottom tab bar (fitness app pattern)
 */
export function Navigation({
  agentOpen,
  agentBusy,
  onToggleAgent,
}: {
  agentOpen: boolean;
  agentBusy: boolean;
  onToggleAgent: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const planning = useLocation().pathname === '/planning';
  const { data: settings } = useQuery({
    queryKey: qk.settings,
    queryFn: settingsApi.get,
    enabled: planning,
  });
  const initials = (settings?.display_name || 'Profil')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  const { data: preference } = useGamePreference();
  const rpg = preference?.enabled === true;
  const profile = { path: '/profile', label: 'Profil', icon: User };
  const desktopItems = planning
    ? [navItems[0], navItems[1], navItems[3], navItems[2], navItems[4]]
    : rpg
      ? [...navItems.slice(0, 4), profile, navItems[4]]
      : navItems;
  const mobileItems = planning
    ? [navItems[0], navItems[1], navItems[3]]
    : rpg
      ? [...navItems.slice(0, 4), profile]
      : navItems;
  const auth = useAuthState();
  return (
    <>
      {planning && (
        <header className="planning-brand-header md:hidden">
          <Link to="/" aria-label="Arete · Accueil">
            <AreteWordmark />
          </Link>
          <Link
            to="/settings"
            aria-label="Réglages et profil"
            className="text-sm text-text-secondary min-h-11 flex items-center"
          >
            {initials}
          </Link>
        </header>
      )}
      {/* Desktop top nav — hidden on mobile */}
      <nav
        aria-label="Navigation principale"
        className={cn(
          'hidden md:block sticky top-0 z-50 bg-void/95 backdrop-blur-sm border-b border-text-muted/20',
          planning && 'planning-desktop-nav',
        )}
      >
        <div className="navigation-shell">
          <div className="flex items-center justify-between h-14">
            <Link to="/" aria-label="Arete · Accueil" className="shrink-0 text-text-primary">
              <AreteWordmark />
            </Link>

            <div className="flex items-center gap-1">
              {desktopItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  aria-label={item.label}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    cn(
                      'navigation-item flex items-center gap-2 px-3 py-2 text-sm font-sans',
                      'border border-transparent transition-colors duration-150 motion-reduce:transition-none',
                      isActive
                        ? 'text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30'
                        : 'text-text-secondary hover:text-text-primary hover:bg-abyss',
                    )
                  }
                >
                  <item.icon className="w-4 h-4" />
                  <span className="hidden lg:inline">
                    {planning && item.path === '/' ? 'Vue d’ensemble' : item.label}
                  </span>
                </NavLink>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={onToggleAgent}
                aria-controls="coach-panel"
                aria-expanded={agentOpen}
                aria-label={agentOpen ? 'Masquer le coach' : 'Ouvrir le coach'}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                  agentOpen
                    ? 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
                    : 'border-text-muted/20 text-text-secondary hover:border-neon-cyan/30 hover:text-neon-cyan',
                )}
              >
                <span className="relative flex" data-busy={agentBusy || undefined}>
                  <AreteMark size={24} />
                  {agentBusy && (
                    <span className="absolute -right-1 top-0 size-1.5 rounded-full bg-neon-cyan" />
                  )}
                </span>
                <span>{rpg || planning ? 'Chiron' : 'Coach'}</span>
              </button>
              {auth.enabled && (
                <Suspense fallback={null}>
                  <AccountButton />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile bottom tab bar — hidden on desktop */}
      <nav
        aria-label="Navigation mobile"
        className={cn(
          'md:hidden fixed bottom-0 left-0 right-0 z-50 bg-void/95 backdrop-blur-sm border-t border-text-muted/20',
          planning && 'planning-mobile-nav',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-around h-16 px-2">
          {mobileItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              aria-label={item.label}
              end={item.path === '/'}
              className={({ isActive }) =>
                cn(
                  'navigation-item relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1 px-1 rounded-lg',
                  'transition-colors duration-150 motion-reduce:transition-none min-w-0',
                  isActive ? 'text-neon-cyan' : 'text-text-muted active:text-text-secondary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('w-5 h-5', isActive && 'stroke-[2.25]')} />
                  <span className="text-[9px] font-sans">
                    {item.path === '/' ? 'Accueil' : item.label}
                  </span>
                  {/* Active indicator; the NavLink is `relative` so it sits on this tab */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute -top-px left-2 right-2 h-0.5 bg-neon-cyan rounded-full transition-opacity duration-[120ms] motion-reduce:transition-none',
                      isActive ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </>
              )}
            </NavLink>
          ))}
          <button
            onClick={onToggleAgent}
            aria-controls="coach-panel"
            aria-expanded={agentOpen}
            aria-label={agentOpen ? 'Masquer le coach' : 'Ouvrir le coach'}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1',
              agentOpen ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-text-muted',
            )}
          >
            <span className="relative flex" data-busy={agentBusy || undefined}>
              <AreteMark size={24} />
              {agentBusy && (
                <span className="absolute -right-1 top-0 size-1.5 rounded-full bg-neon-cyan" />
              )}
            </span>
            <span className="text-[9px] font-sans">{rpg || planning ? 'Chiron' : 'Coach'}</span>
          </button>
        </div>
      </nav>
    </>
  );
}
