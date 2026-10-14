import 'fastify';
import type { SessionUser } from './auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyContextConfig {
    /** route is reachable without a session */
    public?: boolean;
  }
}
