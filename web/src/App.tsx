import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './lib/api';
import { Loading } from './components/ui';
import { usePresence } from './lib/presence';
import { LoginPage } from './pages/Login';
import { RadarPage } from './pages/Radar';
import { ReferencePage } from './pages/Reference';
import { ExplorePage } from './pages/Explore';
import { ArchivePage } from './pages/Archive';
import { CaptionStudioPage } from './pages/CaptionStudio';
import { InsightsPage } from './pages/Insights';
import { SourcesPage } from './pages/Sources';
import { SettingsPage } from './pages/Settings';

export interface Me { id: string; email: string; display_name: string; role: string }

export const NAV = [
  { to: '/', label: 'RADAR', key: 'g r' },
  { to: '/explore', label: 'Explore', key: 'g e' },
  { to: '/archive', label: 'Archive', key: 'g a' },
  { to: '/studio', label: 'Caption Studio', key: 'g c' },
  { to: '/insights', label: 'Insights', key: 'g i' },
  { to: '/sources', label: 'Sources', key: 'g s' },
  { to: '/settings', label: 'Settings', key: '' },
] as const;

const GOTO: Record<string, string> = { r: '/', e: '/explore', a: '/archive', c: '/studio', i: '/insights', s: '/sources' };

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

function useGotoKeys() {
  const nav = useNavigate();
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        armed = Date.now();
        return;
      }
      if (armed && Date.now() - armed < 1200 && GOTO[e.key]) {
        // The second key of a chord must not also trigger a page shortcut (g then s is not "save").
        e.stopImmediatePropagation();
        nav(GOTO[e.key]!);
      }
      armed = 0;
    };
    // Capture phase, so this runs before the page-level shortcut handlers on window.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [nav]);
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: Me }>('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['me'], null);
    window.addEventListener('radar:unauthenticated', onUnauth);
    return () => window.removeEventListener('radar:unauthenticated', onUnauth);
  }, [qc]);

  if (me.isLoading) return <div className="content"><Loading label="Opening RADAR" /></div>;
  const unauth = !me.data || (me.error instanceof ApiError && me.error.status === 401);
  if (unauth) {
    if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) {
      return <LoginPage serverError={me.error} onLoggedIn={() => me.refetch()} />;
    }
    return <LoginPage onLoggedIn={() => me.refetch()} />;
  }
  return <Shell user={me.data!.user} />;
}

function Shell({ user }: { user: Me }) {
  useGotoKeys();
  usePresence();
  const qc = useQueryClient();
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    qc.setQueryData(['me'], null);
  };
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <b><span className="dot" />eccö RADAR</b>
          <span>reference discovery · private</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === '/'}>
                {n.label}
                {n.key ? <span className="key">{n.key}</span> : null}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="nav-foot">
          {user.display_name}
          <br />
          No publishing integrations.
          <br />
          <button className="sm" onClick={logout}>Sign out</button>
        </div>
      </nav>
      <div className="main">
        <nav className="mobile-nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>{n.label}</NavLink>
          ))}
        </nav>
        <Routes>
          <Route path="/" element={<RadarPage />} />
          <Route path="/ref/:ref" element={<ReferencePage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/explore/:id" element={<ExplorePage />} />
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/studio" element={<CaptionStudioPage />} />
          <Route path="/studio/:ref" element={<CaptionStudioPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
