/**
 * Whether a RADAR tab is open in a browser, for the desktop start scripts: they switch RADAR off
 * once the editor has closed every tab. Open pages send a heartbeat; a page being closed sends a
 * "leave" beacon. Browsers slow timers in background tabs to about once a minute, so silence alone
 * only counts after a longer grace period. Kept in memory: a restart simply starts unseen.
 */
export const HEARTBEAT_GRACE_MS = 150_000;
export const LEAVE_GRACE_MS = 20_000;

const tabs = new Map<string, { lastBeat: number; leftAt: number | null }>();

export function heartbeat(tabId: string, now = Date.now()): void {
  tabs.set(tabId, { lastBeat: now, leftAt: null });
  if (tabs.size > 200) {
    const oldest = [...tabs.entries()].sort((a, b) => a[1].lastBeat - b[1].lastBeat)[0];
    if (oldest) tabs.delete(oldest[0]);
  }
}

export function leave(tabId: string, now = Date.now()): void {
  const t = tabs.get(tabId);
  if (t) t.leftAt = now;
}

function tabOpen(t: { lastBeat: number; leftAt: number | null }, now: number): boolean {
  if (t.leftAt !== null && t.leftAt >= t.lastBeat) return now - t.leftAt < LEAVE_GRACE_MS;
  return now - t.lastBeat < HEARTBEAT_GRACE_MS;
}

/** seen: a tab has been open since the server started. closed: it has been, and none is open now. */
export function presence(now = Date.now()): { seen: boolean; openTabs: number; closed: boolean } {
  const open = [...tabs.values()].filter((t) => tabOpen(t, now)).length;
  return { seen: tabs.size > 0, openTabs: open, closed: tabs.size > 0 && open === 0 };
}

export function resetPresence(): void {
  tabs.clear();
}
