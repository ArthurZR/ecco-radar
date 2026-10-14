import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { env } from '../config/env.js';
import { verifyPassword, hashPassword } from './password.js';
import { createSession, destroySession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';
import { AppError } from '../lib/errors.js';

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(500) });

// A fixed hash so unknown emails take the same time as wrong passwords.
const DUMMY_HASH_PROMISE = hashPassword('timing-equaliser-not-a-real-password');

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { public: true, rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = LoginBody.parse(req.body);
      const { rows } = await db().query<{ id: string; password_hash: string; disabled_at: string | null }>(
        'SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = lower($1)',
        [body.email],
      );
      const user = rows[0];
      const ok = await verifyPassword(body.password, user?.password_hash ?? (await DUMMY_HASH_PROMISE));
      if (!user || !ok || user.disabled_at) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
      const token = await createSession(user.id, req.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: env().NODE_ENV === 'production',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      await db().query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id) VALUES ($1, 'login', 'user', $2)`, [user.id, user.id]);
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    await destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));
}
