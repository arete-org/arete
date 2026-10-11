import { useLayoutEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, Database, Dumbbell, Palette, Save, Target, Terminal, User, Users, Watch, X } from 'lucide-react';
import { AreteMark } from '@/components/AreteBrand';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingState } from '@/components';
import { useAuthState } from '@/components/auth/authState';
import { Button, Spinner } from '@/components/ui';
import { settingsApi, type UserSettings } from '@/lib/api';
import { DataTab } from './settings/DataTab';
import { GamificationTab } from './settings/GamificationTab';
import { qk } from '@/lib/queryKeys';
import { applyTheme } from '@/lib/theme';
import {
  AdminTab,
  AppearanceTab,
  CoachTab,
  ConnectionsTab,
  DEFAULT_SETTINGS,
  GoalsTab,
  ProfileTab,
  SystemTab,
  WorkoutTab,
  type LocalSettings,
} from './settings/index';

const TABS = [
  { id: 'profile', label: 'PROFIL', icon: User },
  { id: 'goals', label: 'OBJECTIFS', icon: Target },
  { id: 'workout', label: 'NOTATION', icon: Dumbbell },
  { id: 'connections', label: 'CONNEXIONS', icon: Watch },
  { id: 'coach', label: 'COACH', icon: AreteMark },
  { id: 'gamification', label: 'GAMIFICATION', icon: Target },
  { id: 'appearance', label: 'APPARENCE', icon: Palette },
  { id: 'data', label: 'DONNÉES', icon: Database },
  { id: 'system', label: 'SYSTÈME', icon: Terminal },
] as const;
/** Listed for the owner and admins only. */
const ADMIN_TAB = { id: 'admin', label: 'ADMINISTRATION', icon: Users } as const;

type Tab = (typeof TABS)[number] | typeof ADMIN_TAB;
type TabId = Tab['id'];
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const isTabId = (tabs: readonly Tab[], value: string | null): value is TabId =>
  tabs.some((tab) => tab.id === value);

export function SettingsPage() {
  const { isAdmin } = useAuthState();
  // A tab missing from the list, the admin one included, opens the profile.
  const tabs: readonly Tab[] = isAdmin ? [...TABS, ADMIN_TAB] : TABS;
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isTabId(tabs, tabParam) ? tabParam : 'profile';
  const setActiveTab = (tab: TabId) => setSearchParams(tab === 'profile' ? {} : { tab }, { replace: true });
  const queryClient = useQueryClient();

  const { data: savedSettings, isLoading, isError, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.get,
  });

  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);

  // Adopt fetched settings into local form state whenever the server copy changes
  const [syncedFrom, setSyncedFrom] = useState<UserSettings | null>(null);
  if (savedSettings && savedSettings !== syncedFrom) {
    setSyncedFrom(savedSettings);
    const { user_id, ...rest } = savedSettings;
    setSettings(rest);
  }

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  useLayoutEffect(() => {
    if (!savedSettings) return;
    applyTheme(settings.theme);
    // Read the current cache on exit: a successful save may have changed it.
    return () => {
      const saved = queryClient.getQueryData<UserSettings>(['settings']);
      if (saved) applyTheme(saved.theme);
    };
  }, [settings.theme, savedSettings, queryClient]);

  const hasChanges = useMemo(() => {
    if (!savedSettings) return false;
    const { user_id, ...saved } = savedSettings;
    return JSON.stringify(saved) !== JSON.stringify(settings);
  }, [settings, savedSettings]);

  const saveMutation = useMutation({
    mutationFn: settingsApi.update,
    onMutate: () => setSaveStatus('saving'),
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      // The threshold pace feeds the VDOT when Garmin has no race prediction.
      queryClient.invalidateQueries({ queryKey: qk.paces });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    },
    onError: () => {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
  });

  const updateSetting = <K extends keyof LocalSettings>(key: K, value: LocalSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-void p-6 flex items-center justify-center">
        <LoadingState message="CHARGEMENT DES RÉGLAGES…" />
      </div>
    );
  }

  if (isError) {
    return <ErrorState message="RÉGLAGES INDISPONIBLES" onRetry={() => refetch()} />;
  }

  const tabProps = { settings, updateSetting };

  return (
    <div className="page-shell bg-void">
      <div className="page-content">
        <header className="flex justify-between items-center mb-4 sm:mb-8 animate-fade-down">
          <h1 className="page-title">Réglages</h1>
          {hasChanges && (
            <Button
              variant="green"
              strong
              onClick={() => saveMutation.mutate(settings)}
              disabled={saveStatus === 'saving'}
              className="animate-scale-in"
            >
              <SaveStatusContent status={saveStatus} />
            </Button>
          )}
        </header>

        {/* Below md the tabs become one scrolling row above the panel. */}
        <div className="flex flex-col md:flex-row gap-4 md:gap-6">
          <nav aria-label="Sections des réglages" className="settings-nav md:w-48 md:shrink-0 -mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto animate-fade-left">
            <div className="flex md:flex-col gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3 py-2 md:px-4 md:py-3 rounded',
                    'text-sm font-sans transition-all text-left whitespace-nowrap',
                    activeTab === tab.id
                      ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30'
                      : 'text-text-muted hover:text-text-secondary hover:bg-abyss'
                  )}
                >
                  <tab.icon size={16} className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </div>
          </nav>

          <div key={activeTab} className="flex-1 min-w-0 glass-panel p-4 sm:p-6 animate-fade-up">
            {activeTab === 'profile' && <ProfileTab {...tabProps} />}
            {activeTab === 'goals' && <GoalsTab {...tabProps} />}
            {activeTab === 'workout' && <WorkoutTab {...tabProps} />}
            {activeTab === 'connections' && <ConnectionsTab />}
            {activeTab === 'coach' && <CoachTab {...tabProps} />}
            {activeTab === 'gamification' && <GamificationTab />}
            {activeTab === 'appearance' && <AppearanceTab {...tabProps} />}
            {activeTab === 'data' && <DataTab />}
            {activeTab === 'system' && <SystemTab />}
            {activeTab === 'admin' && <AdminTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaveStatusContent({ status }: { status: SaveStatus }) {
  switch (status) {
    case 'saving':
      return (
        <>
          <Spinner />
          ENREGISTREMENT…
        </>
      );
    case 'saved':
      return (
        <>
          <Check className="w-4 h-4" />
          ENREGISTRÉ
        </>
      );
    case 'error':
      return (
        <>
          <X className="w-4 h-4 text-danger-red" />
          ÉCHEC
        </>
      );
    default:
      return (
        <>
          <Save className="w-4 h-4" />
          ENREGISTRER
        </>
      );
  }
}
