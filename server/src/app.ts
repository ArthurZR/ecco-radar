import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { db } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { SESSION_COOKIE, resolveSession } from './auth/sessions.js';
import { authRoutes } from './auth/routes.js';
import { referenceRoutes } from './modules/references/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { insightsRoutes } from './modules/insights/routes.js';
import { sourceRoutes } from './modules/sources/routes.js';
import { explorationRoutes } from './modules/exploration/routes.js';
import { rankingRoutes } from './modules/ranking/routes.js';
import { captionRoutes } from './modules/captions/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { postMediaRoutes } from './modules/post-media/routes.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const config = env();
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // never log cookies, auth headers or request bodies
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        }
      : false,
    bodyLimit: 1_000_000,
    trustProxy: config.NODE_ENV === 'production',
  });

  app.decorateRequest('user', null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'https:', 'data:'], // previews are hot-linked from their sources
        mediaSrc: ["'self'", 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // CSRF: session cookies are SameSite=Strict; additionally require a same-origin Origin header on writes.
    if (MUTATING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.APP_ORIGIN && origin !== `http://localhost:${config.PORT}`) {
        throw new AppError(403, 'bad_origin', 'Cross-origin request rejected');
      }
    }
    req.user = await resolveSession(req.cookies[SESSION_COOKIE]);
    if (!req.user && !req.routeOptions.config.public) {
      throw new AppError(401, 'unauthenticated', 'Sign in required');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', message: 'Request validation failed', details: err.issues });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'request_error', message: e.message });
    }
    req.log.error({ err: { message: e.message, stack: e.stack } }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong on the server' });
  });

  // Public liveness check for container health probes: confirms the database answers, reveals nothing else.
  app.get('/api/health', { config: { public: true } }, async (_req, reply) => {
    try {
      await db().query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(referenceRoutes);
  await app.register(importRoutes);
  await app.register(insightsRoutes);
  await app.register(sourceRoutes);
  await app.register(explorationRoutes);
  await app.register(rankingRoutes);
  await app.register(captionRoutes);
  await app.register(settingsRoutes);
  await app.register(postMediaRoutes);

  // Serve the built web app from the same origin in production, or whenever WEB_DIST_DIR is set
  // explicitly (the end-to-end tests do this).
  const webDist = config.WEB_DIST_DIR ?? path.resolve(process.cwd(), '../web/dist');
  if ((config.NODE_ENV === 'production' || config.WEB_DIST_DIR) && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
