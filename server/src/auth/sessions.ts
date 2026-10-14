import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/pool.js';

export const SESSION_COOKIE = 'radar_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  role: 'editor' | 'admin';
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: string, userAgent: string | undefined): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db().query(
    `INSERT INTO sessions(token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4)`,
    [hashToken(token), userId, SESSION_TTL_MS, userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await db().query<SessionUser>(
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.token_hash = $1 AND s.user_id = u.id AND s.expires_at > now() AND u.disabled_at IS NULL
      RETURNING u.id, u.email, u.display_name, u.role`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db().query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function purgeExpiredSessions(): Promise<void> {
  await db().query('DELETE FROM sessions WHERE expires_at < now()');
}
