-- Exploration sessions, discovery provenance, background jobs, ranking configuration,
-- learned-preference resets and historical analytics imports.

-- ---------------------------------------------------------------------------
-- Exploration
-- ---------------------------------------------------------------------------
CREATE TABLE exploration_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query               text NOT NULL,
  concepts            text[] NOT NULL DEFAULT '{}',
  mode                text NOT NULL CHECK (mode IN ('familiar', 'adjacent', 'experimental')),
  source_ids          text[] NOT NULL,
  categories          text[] NOT NULL DEFAULT '{}',
  creator             text,
  period_from         integer,
  period_to           integer,
  novelty             real NOT NULL DEFAULT 0.5 CHECK (novelty BETWEEN 0 AND 1),
  depth               integer NOT NULL DEFAULT 1 CHECK (depth BETWEEN 0 AND 3),
  max_queries         integer NOT NULL DEFAULT 8 CHECK (max_queries BETWEEN 1 AND 40),
  max_results         integer NOT NULL DEFAULT 60 CHECK (max_results BETWEEN 1 AND 500),
  use_external_ai     boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  trigger             text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled', 'related_reference', 'repeat')),
  parent_session_id   uuid REFERENCES exploration_sessions(id),
  parent_reference_id uuid REFERENCES reference_items(id),
  schedule_id         uuid,
  results_count       integer NOT NULL DEFAULT 0,
  new_count           integer NOT NULL DEFAULT 0,
  error_summary       text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz
);
CREATE INDEX exploration_sessions_created_idx ON exploration_sessions(created_at DESC);

-- Every query actually executed, forming the bounded expansion tree.
CREATE TABLE exploration_queries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES exploration_sessions(id) ON DELETE CASCADE,
  parent_query_id uuid REFERENCES exploration_queries(id),
  query           text NOT NULL,
  depth           integer NOT NULL CHECK (depth >= 0),
  origin          text NOT NULL CHECK (origin IN ('user', 'concept', 'history', 'approved_tags', 'seed_map',
                                                  'knowledge_graph', 'creator', 'ai_suggestion', 'related_reference')),
  rationale       text NOT NULL,
  source_id       text REFERENCES sources(id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  results_count   integer NOT NULL DEFAULT 0,
  error           text,
  executed_at     timestamptz,
  UNIQUE (session_id, query, source_id)
);

-- How each reference was found. A reference can be rediscovered by later sessions.
CREATE TABLE reference_discoveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id    uuid NOT NULL REFERENCES reference_items(id),
  session_id      uuid REFERENCES exploration_sessions(id) ON DELETE SET NULL,
  query_id        uuid REFERENCES exploration_queries(id) ON DELETE SET NULL,
  source_id       text NOT NULL REFERENCES sources(id),
  method          text NOT NULL CHECK (method IN ('search', 'manual_import', 'rss', 'related_reference')),
  query_text      text,
  -- Ordered provenance chain, e.g. [{kind:'query',label:'…'},{kind:'entity',label:'…',ref:'Q…'}]
  path            jsonb NOT NULL DEFAULT '[]'::jsonb,
  rank_in_results integer,
  -- snapshot of the score breakdown when it was discovered (explanation of why it surfaced)
  score_snapshot  jsonb,
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  is_first        boolean NOT NULL DEFAULT false
);
CREATE INDEX reference_discoveries_ref_idx ON reference_discoveries(reference_id);
CREATE INDEX reference_discoveries_session_idx ON reference_discoveries(session_id);

CREATE TABLE saved_searches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scope      text NOT NULL CHECK (scope IN ('feed', 'exploration')),
  params     jsonb NOT NULL,          -- validated by zod before insert
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT false,   -- background discovery is opt-in
  params             jsonb NOT NULL,                   -- exploration params, validated by zod
  interval_minutes   integer NOT NULL CHECK (interval_minutes >= 60),
  max_runs_per_day   integer NOT NULL DEFAULT 4 CHECK (max_runs_per_day BETWEEN 1 AND 24),
  last_run_at        timestamptz,
  next_run_at        timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Background jobs (Postgres-backed queue with SKIP LOCKED)
-- The allowed kinds are fixed here: there is deliberately no publishing job.
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('run_exploration', 'embed_reference', 'schedule_tick', 'refresh_source_status')),
  payload         jsonb NOT NULL,
  idempotency_key text UNIQUE,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs(run_after) WHERE status = 'queued';

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ranking (versioned, reversible) & learned preferences
-- ---------------------------------------------------------------------------
CREATE TABLE ranking_configs (
  version    serial PRIMARY KEY,
  weights    jsonb NOT NULL,          -- validated by zod (component -> weight)
  diversity  jsonb NOT NULL,          -- validated by zod (window, penalties)
  note       text,
  is_active  boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ranking_configs_one_active ON ranking_configs(is_active) WHERE is_active;

-- Learned preferences are derived from editorial_decisions after the latest reset, so resetting
-- never deletes the decisions themselves and can be undone by removing the reset row.
CREATE TABLE preference_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reset_at   timestamptz NOT NULL DEFAULT now(),
  note       text,
  undone_at  timestamptz,
  created_by uuid REFERENCES users(id)
);

-- Explicit editor overrides of a learned feature (e.g. mute a creator, boost a movement)
CREATE TABLE preference_overrides (
  feature_kind text NOT NULL CHECK (feature_kind IN ('tag', 'creator', 'source', 'entity', 'media_type')),
  feature_value text NOT NULL,
  weight       real NOT NULL CHECK (weight BETWEEN -1 AND 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_kind, feature_value)
);

-- ---------------------------------------------------------------------------
-- Historical analytics imports
-- ---------------------------------------------------------------------------
CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('instagram_posts', 'x_account_daily', 'x_posts')),
  filename         text NOT NULL,
  file_sha256      text NOT NULL,
  account_filter   text,
  column_mapping   jsonb NOT NULL,
  row_count        integer NOT NULL DEFAULT 0,
  imported_count   integer NOT NULL DEFAULT 0,
  skipped_count    integer NOT NULL DEFAULT 0,
  duplicate_count  integer NOT NULL DEFAULT 0,
  invalid_count    integer NOT NULL DEFAULT 0,
  status           text NOT NULL CHECK (status IN ('committed', 'rolled_back')),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  rolled_back_at   timestamptz
);
-- Re-import protection: the same file cannot be committed twice while a committed batch exists.
CREATE UNIQUE INDEX import_batches_no_reimport ON import_batches(kind, file_sha256) WHERE status = 'committed';

-- The original rows exactly as they appeared in the file.
CREATE TABLE import_raw_rows (
  id        bigserial PRIMARY KEY,
  batch_id  uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  raw       jsonb NOT NULL,
  outcome   text NOT NULL CHECK (outcome IN ('imported', 'skipped_account', 'duplicate', 'invalid')),
  errors    text[] NOT NULL DEFAULT '{}',
  UNIQUE (batch_id, row_index)
);

-- Individual posts only. Daily account totals live in account_daily_metrics.
CREATE TABLE historical_posts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            text NOT NULL CHECK (platform IN ('instagram', 'x')),
  platform_post_id    text,
  account_handle      text NOT NULL,
  account_name        text,
  caption             text,
  permalink           text,
  canonical_permalink text,
  format              text,
  published_at        timestamptz,
  duration_seconds    numeric,
  -- media is not part of the exports; visual analysis is incomplete until media is supplied
  media_available     boolean NOT NULL DEFAULT false,
  text_embedding      real[],
  text_embedding_model text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX historical_posts_platform_id ON historical_posts(platform, platform_post_id) WHERE platform_post_id IS NOT NULL;
CREATE UNIQUE INDEX historical_posts_permalink ON historical_posts(platform, canonical_permalink) WHERE canonical_permalink IS NOT NULL;

-- Which batches contributed each post (a post survives rollback of one batch if another still holds it)
CREATE TABLE historical_post_imports (
  post_id    uuid NOT NULL REFERENCES historical_posts(id) ON DELETE CASCADE,
  batch_id   uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  raw_row_id bigint REFERENCES import_raw_rows(id) ON DELETE SET NULL,
  PRIMARY KEY (post_id, batch_id)
);

-- Metric observations per post per batch. Only metrics present in the file are stored;
-- missing metrics are absent rows, never zeros.
CREATE TABLE historical_post_metrics (
  post_id  uuid NOT NULL REFERENCES historical_posts(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  metric   text NOT NULL CHECK (metric IN ('views', 'reach', 'impressions', 'likes', 'comments', 'shares',
                                           'reposts', 'saves', 'bookmarks', 'follows', 'replies',
                                           'profile_visits', 'engagements')),
  value    numeric NOT NULL CHECK (value >= 0),
  PRIMARY KEY (post_id, batch_id, metric)
);

-- Features derived from post text. Visual features would carry evidence 'media'.
CREATE TABLE historical_post_features (
  post_id      uuid NOT NULL REFERENCES historical_posts(id) ON DELETE CASCADE,
  feature_kind text NOT NULL CHECK (feature_kind IN ('topic', 'term', 'hashtag', 'mention', 'period', 'caption_length', 'format')),
  value        text NOT NULL,
  evidence     text NOT NULL CHECK (evidence IN ('caption_text', 'metadata', 'editor', 'media')),
  PRIMARY KEY (post_id, feature_kind, value)
);

-- Daily account-level aggregates (e.g. X account overview). Never linked to individual posts.
CREATE TABLE account_daily_metrics (
  id             bigserial PRIMARY KEY,
  platform       text NOT NULL CHECK (platform IN ('instagram', 'x')),
  account_handle text NOT NULL,
  metric_date    date NOT NULL,
  metric         text NOT NULL,
  value          numeric NOT NULL,
  batch_id       uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  UNIQUE (platform, account_handle, metric_date, metric, batch_id)
);
CREATE INDEX account_daily_metrics_date_idx ON account_daily_metrics(platform, account_handle, metric_date);
