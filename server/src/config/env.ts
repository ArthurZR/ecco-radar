import { z } from 'zod';

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(8787),
  RUN_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  FLICKR_API_KEY: optionalSecret,
  TUMBLR_API_KEY: optionalSecret,
  SOURCE_CONTACT: z.string().default('unset'),
  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  WEB_DIST_DIR: z.string().optional(),
  // Where downscaled copies of eccö's own post images are kept. Relative paths resolve from the
  // server's working directory.
  MEDIA_DIR: z.string().min(1).default('data/media'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test hook: forget the cached env so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
