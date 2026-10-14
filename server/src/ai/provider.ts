import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/pool.js';
import { env } from '../config/env.js';

/**
 * Provider-agnostic text generation. Keys stay on the server; the browser never sees them.
 * The only external AI traffic RADAR produces goes through this interface, and only when the
 * editor has enabled external AI in Settings.
 */
export interface TextGenerationRequest {
  purpose: 'caption_draft' | 'caption_rewrite' | 'query_expansion';
  system: string;
  prompt: string;
  maxTokens?: number;
  /** The exploration run this call belongs to, so its spend can be capped and shown. */
  explorationSessionId?: string;
}

export interface TextGenerationProvider {
  readonly name: string;
  readonly model: string;
  generate(req: TextGenerationRequest): Promise<string>;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

async function recordUsage(provider: string, model: string, req: TextGenerationRequest, ok: boolean, input?: number, output?: number, error?: string) {
  await db().query(
    `INSERT INTO ai_usage(provider, model, purpose, input_tokens, output_tokens, succeeded, error, exploration_session_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [provider, model, req.purpose, input ?? null, output ?? null, ok, error?.slice(0, 500) ?? null, req.explorationSessionId ?? null],
  );
}

/** AI tokens (input + output) recorded for one exploration run. */
export async function sessionAiTokens(sessionId: string): Promise<number> {
  const r = await db().query<{ used: number }>(
    `SELECT coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::int AS used FROM ai_usage WHERE exploration_session_id = $1`,
    [sessionId],
  );
  return r.rows[0]!.used;
}

export class AnthropicProvider implements TextGenerationProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async generate(req: TextGenerationRequest): Promise<string> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4000,
        // Re-runs on a fallback model if a safety classifier declines a request.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      });
      await recordUsage(this.name, response.model, req, response.stop_reason !== 'refusal', response.usage.input_tokens, response.usage.output_tokens);
      if (response.stop_reason === 'refusal') throw new AiUnavailableError('The AI provider declined this request.');
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) throw new AiUnavailableError('The AI provider returned no text.');
      return text;
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      const message =
        err instanceof Anthropic.AuthenticationError ? 'The Anthropic API key was rejected.'
        : err instanceof Anthropic.RateLimitError ? 'The AI provider is rate-limiting requests; try again shortly.'
        : err instanceof Anthropic.APIConnectionError ? 'Could not reach the AI provider.'
        : err instanceof Anthropic.APIError ? `AI provider error (${err.status ?? 'unknown'}).`
        : 'AI generation failed.';
      await recordUsage(this.name, this.model, req, false, undefined, undefined, message);
      throw new AiUnavailableError(message);
    }
  }
}

export async function externalAiEnabled(): Promise<boolean> {
  const r = await db().query<{ value: boolean }>(`SELECT value FROM app_settings WHERE key = 'external_ai_enabled'`);
  return r.rows[0]?.value === true;
}

/** Default cap on AI tokens (input + output) per rolling 24 hours. The editor can change or remove it. */
export const DEFAULT_DAILY_TOKEN_LIMIT = 200_000;

/**
 * The measurable part of AI cost: tokens recorded in `ai_usage` over the last 24 hours, against the
 * editor's limit (null = no limit). The check runs before each call, so one call can end slightly
 * above the limit; the next one is refused.
 */
export async function aiBudget(): Promise<{ limit: number | null; usedLast24h: number }> {
  const [setting, used] = await Promise.all([
    db().query<{ value: number | null }>(`SELECT value FROM app_settings WHERE key = 'ai_daily_token_limit'`),
    db().query<{ used: number }>(
      `SELECT coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::int AS used
         FROM ai_usage WHERE created_at > now() - interval '24 hours'`,
    ),
  ]);
  const limit = setting.rows.length ? setting.rows[0]!.value : DEFAULT_DAILY_TOKEN_LIMIT;
  return { limit, usedLast24h: used.rows[0]!.used };
}

async function budgetReason(): Promise<string | null> {
  const { limit, usedLast24h } = await aiBudget();
  if (limit !== null && usedLast24h >= limit) {
    return `The daily AI limit is reached (${usedLast24h.toLocaleString('en')} of ${limit.toLocaleString('en')} tokens in the last 24 hours). Raise it in Settings or wait.`;
  }
  return null;
}

let override: TextGenerationProvider | null | undefined;
/** Test hook. */
export function setTextProvider(p: TextGenerationProvider | null | undefined): void {
  override = p;
}

/** Returns the configured provider, or a reason why none is available. */
export async function getTextProvider(): Promise<{ provider: TextGenerationProvider } | { provider: null; reason: string }> {
  let provider: TextGenerationProvider;
  if (override !== undefined) {
    if (!override) return { provider: null, reason: 'disabled in test' };
    provider = override;
  } else {
    const key = env().ANTHROPIC_API_KEY;
    if (!key) return { provider: null, reason: 'No AI provider is configured (ANTHROPIC_API_KEY is not set).' };
    if (!(await externalAiEnabled())) return { provider: null, reason: 'External AI processing is turned off in Settings.' };
    provider = new AnthropicProvider(key, env().ANTHROPIC_MODEL);
  }
  const overBudget = await budgetReason();
  return overBudget ? { provider: null, reason: overBudget } : { provider };
}
