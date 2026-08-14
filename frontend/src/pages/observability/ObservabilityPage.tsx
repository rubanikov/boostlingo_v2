import { useEffect, useState } from 'react';
import { LoginCard } from './LoginCard';
import { DashboardView } from './DashboardView';
import { DisabledState, LoadingState, UnreachableState } from './ObservabilityStates';
import { fetchConfig, logout } from './observabilityApi';

type View = 'loading' | 'disabled' | 'login' | 'signed-in' | 'unavailable';

export function ObservabilityPage() {
  const [view, setView] = useState<View>('loading');

  async function loadConfig() {
    setView('loading');
    const result = await fetchConfig();
    if (result.status === 'unavailable') {
      setView('unavailable');
      return;
    }
    if (result.status !== 'ok' || !result.data.enabled) {
      setView('disabled');
      return;
    }
    if (!result.data.authenticated) {
      setView('login');
      return;
    }
    setView('signed-in');
  }

  async function handleLogout() {
    await logout();
    setView('login');
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  if (view === 'loading') return <LoadingState />;
  if (view === 'disabled') return <DisabledState />;
  if (view === 'login') {
    return <LoginCard onLoggedIn={() => setView('signed-in')} onDisabled={() => setView('disabled')} />;
  }
  if (view === 'unavailable') {
    return (
      <UnreachableState onRetry={() => setView('signed-in')} onLogout={() => void handleLogout()} />
    );
  }
  return (
    <DashboardView
      onLogout={() => void handleLogout()}
      onUnauthenticated={() => setView('login')}
      onDisabled={() => setView('disabled')}
      onUnavailable={() => setView('unavailable')}
    />
  );
}
