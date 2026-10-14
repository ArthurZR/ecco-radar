import { useEffect } from 'react';
import { api } from './api';

/**
 * Tells the server this tab is open, so the desktop start script can switch RADAR off once every
 * RADAR tab is closed. A heartbeat every 30 s, another when the tab comes back into view, and a
 * "leave" beacon as the page closes (a reload sends one too, then a heartbeat straight after).
 */
export function usePresence(): void {
  useEffect(() => {
    const tabId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2, 14)}`;
    const beat = () => {
      api.post('/api/presence/heartbeat', { tabId }).catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    const onLeave = () => {
      navigator.sendBeacon?.('/api/presence/leave', new Blob([JSON.stringify({ tabId })], { type: 'text/plain' }));
    };
    beat();
    const timer = window.setInterval(beat, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onLeave);
    };
  }, []);
}
