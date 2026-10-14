# Architecture

```
web (React SPA) ──/api──▶ server (Fastify) ──▶ PostgreSQL
                               │
                               ├─ worker (same process by default): job queue in Postgres
                               ├─ source adapters ──GET only, SSRF-guarded──▶ public APIs / feeds
                               └─ AI provider (optional, opt-in) ──▶ Anthropic API
```

## Server modules (`server/src/modules`)

| Module | Responsibility |
|---|---|
| `references` | Ingest, permanent IDs, feed query, detail, status workflow, notes, tags, reports, duplicates |
| `sources` | Adapters, registry, live test, RSS feeds, manual URL import |
| `exploration` | Query expansion, exploration sessions (checkpointed), schedules |
| `ranking` | Scoring components, versioned configs, diversity re-ranking, learned preferences |
| `jobs` | Postgres job queue (`FOR UPDATE SKIP LOCKED`) and worker loop |
| `imports` | CSV parsing/normalisation, preview, commit, rollback |
| `insights` | Descriptive statistics over imports and editorial decisions |
| `captions` | Fact sheet, grounded template, AI drafts/rewrites, verification flags, final caption |
| `settings` | AI opt-in, background pause, AI usage |

## Hard rules and where they are enforced

- **No publication.** There is no publishing code anywhere. The HTTP client exposes only `getText`,
  `getBytes` and `getJson` (all GET). The `jobs.kind` column has a CHECK constraint listing the only job types
  (`run_exploration`, `embed_reference`, `schedule_tick`, `refresh_source_status`), so a publish job
  cannot be stored. `publication_reports.verification` can only be `user_reported`. A test walks the
  whole status pipeline while asserting no outbound request is made, and another scans `server/src`
  and `web/src` for social-platform write endpoints.
- **Permanent IDs.** `reference_number_seq` issues numbers; a trigger forbids changing `ref_number` and
  another blocks `DELETE` on `reference_items` (deletion is a soft `deleted_at`). Note that `TRUNCATE`
  bypasses row triggers; only the test suite uses it, and only on a database named `*test*`.
- **No fabrication.** Adapters store what the source states (`verification_status = source_metadata`,
  `attribution_status = source_provided`). Inferred tags and entities are stored with origin/evidence
  and shown as unverified until the editor confirms them. Wikidata statements are `documented`;
  anything else is `inferred`. Missing metrics are stored as missing, never zero.
- **Secrets.** Read from the server environment (`config/env.ts`); the browser receives none.
- **SSRF.** `lib/ssrf.ts` checks URL shape (http/https, ports 80/443, no credentials, no local or
  single-label hosts, no private ranges) and a custom DNS lookup on the undici agent rejects non-public
  answers, which also covers DNS rebinding. Redirects are re-validated and bodies are size-capped.

## Data model (main tables)

- `reference_items`: one row per canonical URL, with source-stated metadata, status, embeddings,
  `visual_hash`, `deleted_at`. `reference_discoveries` records every time it was found, with the
  provenance `path` and a score snapshot.
- `reference_tags` (origin, state), `cultural_entities`, `reference_entities` (evidence),
  `entity_relations`, `reference_relations` (duplicate candidates, confirmations).
- `editorial_decisions` (every status change, report and relationship decision), `research_notes`,
  `research_sources`, `audit_events`.
- `caption_drafts` (versioned, never overwritten) and `final_captions` (the editor's text, separate).
- `exploration_sessions`, `exploration_queries` (tree with origin and rationale), `discovery_schedules`.
- `ranking_configs` (versioned, one active), `preference_resets`, `preference_overrides`.
- `import_batches`, `import_raw_rows`, `historical_posts`, `historical_post_metrics` (per batch, so
  re-imports become newer observations), `historical_post_features`, `account_daily_metrics`
  (X daily totals, never linked to posts).
- `historical_post_media` (eccö's own post images supplied by the editor: a downscaled file in
  `MEDIA_DIR` plus colour-tone-v1 vector, dhash-64 and pixel means; the match note says how each was
  tied to its post), `post_media_imports` (one row per Instagram-export import, for undo).

## Ranking

`ranking/score.ts` computes named components, each with a value in [0, 1] (or `null` when it cannot be
computed) and a note explaining it:

editorial affinity, cultural relevance, query relevance, visual affinity (colour/tone similarity to
approved references; `null` until 3 approved references have analysed images), novelty, research
potential, source reliability, audience resonance.

The total is a weighted mean of the available components minus penalties (already published by eccö,
reported misattribution, inaccessible, no traceable connection in experimental mode). Familiar,
adjacent and experimental modes multiply some weights. Audience resonance is capped at weight 1.5,
needs at least 20 imported posts, and is shrunk toward the median. After scoring, `diversity.ts`
greedily re-ranks with penalties for repeating a creator, source, tags or near-duplicate text inside a
window. Every config change creates a new version that can be reactivated.

Learning (`ranking/profile.ts`) uses the latest status decision per reference since the last reset.
Item-level rejections count weakly; topic, creator or source rejections count fully for that feature.
Resets can be undone and overrides replace learned values.

## Exploration

`expandQuery` builds a bounded list of follow-up queries from the strategies the mode allows (concept,
eccö history, approved tags, the eccö territory map, Wikidata, creator, optional AI), interleaving
strategies so no single one dominates. The engine runs queries breadth-first up to `depth`,
`maxQueries` and `maxResults`, checkpointing after each query so pause, resume and cancel work, and
records the full path for every result.

## Embeddings and scaling

`lib/embedding.ts` provides `lexical-hash-v1`: feature-hashed unigrams and bigrams into 384 dimensions.
It captures shared wording, not meaning or images, and is labelled that way in the UI. Vectors are
stored as `real[]` and compared in the application over a bounded candidate set (2,000 for the ranked
feed, 3,000 for related items), which is fast for a single editor's archive. To scale or add a neural
model: install pgvector, add a `vector` column, implement `EmbeddingProvider` for the model, backfill
via the `embed_reference` job, and replace the in-app cosine scans with an indexed nearest-neighbour
query. Visual similarity should get its own provider and column so it stays separate from text.

## Groups (clustering)

`lib/kmeans.ts` is a deterministic spherical k-means (cosine, k-means++ seeding with a fixed seed).
`references/clusters.ts` groups the newest 2,000 live references (rejected and deleted ones excluded)
into about sqrt(n/2) groups (2 to 12), either by text vector or by colour/tone vector, never a mix of
the two. Each group is described only by data: tags carried by at least 40% of its members, its
status mix, and how tight it is (mean cosine to the centre). Archive → Groups shows them. Groups are
recomputed on request and change no score or record.

## Performance context on a reference

`insights/reference-performance.ts` shows, on the reference page: the imported post whose link
matches a publication the editor recorded for that reference (with its latest metrics), up to five
imported Instagram posts whose captions share wording with the reference (lexical similarity ≥ 0.3,
labelled as wording, not image), and the archive-wide median engagement per reach for context. X daily
account totals are never used because they cannot be tied to a post. None of this feeds the score.

## Visual analysis

`lib/visual.ts` uses sharp to compute two things from a preview image: a 64-bit difference hash
(`dhash-64`, for near-identical copies) and a 76-dimension colour/tone vector (`colour-tone-v1`: RGB,
luminance and saturation histograms, square-root normalised). The worker queues every reference
with a preview that has not been analysed (`embed_reference` jobs, swept once a minute); the image is
fetched once through the same GET-only, SSRF-guarded client with an 8 MB cap and a 50-megapixel
decode limit. Results live in `visual_hash` and `visual_embedding`, apart from the text embedding.
Failures are stored in `visual_error` and shown on the reference; they are retried only when the
editor asks. The whole step can be switched off in Settings.

## AI

`ai/provider.ts` wraps the Anthropic SDK. It runs only when `ANTHROPIC_API_KEY` is set **and** the
editor has enabled external AI in Settings. Captions are generated from the fact sheet only (source
metadata, confirmed relations, editor notes); analytics are never sent. Every draft is checked by
`flagUnsupported` for years, numbers, names and evaluative claims absent from the facts. Usage is
logged in `ai_usage`, and `getTextProvider` refuses new calls once the tokens recorded in the last 24
hours reach the editor's limit (`ai_daily_token_limit`, default 200,000; null means no limit). The check
runs before each call, so a single call can finish slightly above the limit.

## Web (`web/src`)

React Router pages under `pages/`, TanStack Query for server state, plain CSS tokens in `styles.css`.
Charts are inline SVG (`components/charts.tsx`) with a crosshair tooltip and a table view. The feed is
URL-driven (filters live in the query string) and keyboard-operable (`?` lists shortcuts). It has a
dense masonry view and a research view (one row per reference with every ranking reason, caveat,
tag and the attribution basis); `v` switches, and the choice is remembered in the browser.

## Tests

- `server/test`: Vitest against a real PostgreSQL database with fake HTTP.
- `web/src/__tests__`: Vitest for UI helpers and components.
- `e2e/`: Playwright against the real API and built web app (`server/scripts/e2e-server.ts` seeds
  SYNTHETIC data and replaces the HTTP client with one that refuses every request). A fixture fails
  any test in which the browser contacts an origin other than RADAR.
