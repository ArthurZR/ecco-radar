import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db/pool.js';
import { HEARTBEAT_GRACE_MS, LEAVE_GRACE_MS, heartbeat, leave, presence, resetPresence } from '../src/lib/presence.js';
import { appWithSession, resetDb } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  resetPresence();
});
afterAll(closeDb);

describe('tab presence for the desktop start scripts', () => {
  it('is not "closed" before any tab has been open', () => {
    expect(presence()).toEqual({ seen: false, openTabs: 0, closed: false });
  });

  it('counts a closed tab after a short grace, and a reload in that grace keeps it open', () => {
    heartbeat('tab-aaaaaaaa', 0);
    leave('tab-aaaaaaaa', 1000);
    expect(presence(1000 + LEAVE_GRACE_MS - 1).closed).toBe(false);
    heartbeat('tab-aaaaaaaa', 2000); // the page came back (a reload)
    expect(presence(2000 + LEAVE_GRACE_MS + 1).closed).toBe(false);
    leave('tab-aaaaaaaa', 3000);
    expect(presence(3000 + LEAVE_GRACE_MS + 1).closed).toBe(true);
  });

  it('waits out slow background-tab timers before treating silence as closed', () => {
    heartbeat('tab-aaaaaaaa', 0);
    heartbeat('tab-bbbbbbbb', 0);
    leave('tab-aaaaaaaa', 10);
    expect(presence(HEARTBEAT_GRACE_MS - 1)).toEqual({ seen: true, openTabs: 1, closed: false });
    expect(presence(HEARTBEAT_GRACE_MS + 1).closed).toBe(true);
  });

  it('accepts heartbeats only from a signed-in page, and the state answer is public', async () => {
    const { app, cookie } = await appWithSession();
    expect((await app.inject({ method: 'POST', url: '/api/presence/heartbeat', payload: { tabId: 'tab-cccccccc' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/presence/heartbeat', headers: { cookie }, payload: { tabId: 'tab-cccccccc' } })).statusCode).toBe(200);
    const leaveRes = await app.inject({ method: 'POST', url: '/api/presence/leave', headers: { cookie, 'content-type': 'text/plain' }, payload: JSON.stringify({ tabId: 'tab-cccccccc' }) });
    expect(leaveRes.statusCode).toBe(200);
    const state = await app.inject({ url: '/api/presence' });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ seen: true });
  });
});
