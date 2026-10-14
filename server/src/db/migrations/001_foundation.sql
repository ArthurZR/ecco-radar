-- eccö RADAR foundation schema.
-- Conventions: snake_case, uuid primary keys, timestamptz everywhere, CHECK constraints for enums
-- so invalid states are rejected by the database itself, not only by application code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users & sessions (single editor today; multi-user ready)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);

CREATE TABLE sessions (
  -- sha256 of the opaque token held in the cookie; the raw token is never stored
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id                       text PRIMARY KEY,           -- adapter key, e.g. 'wikimedia_commons'
  name                     text NOT NULL,
  connector_type           text NOT NULL CHECK (connector_type IN ('api', 'rss', 'manual', 'knowledge')),
  base_url                 text,
  enabled                  boolean NOT NULL DEFAULT true,
  -- 'unverified' = code exists but live retrieval has never succeeded from this deployment
  status                   text NOT NULL DEFAULT 'unverified'
                           CHECK (status IN ('active', 'unverified', 'unavailable', 'rate_limited', 'needs_configuration', 'disabled')),
  requires_credentials     boolean NOT NULL DEFAULT false,
  rate_limit_per_minute    integer NOT NULL DEFAULT 30 CHECK (rate_limit_per_minute > 0),
  baseline_reliability     real NOT NULL DEFAULT 0.5 CHECK (baseline_reliability BETWEEN 0 AND 1),
  attribution_requirements text,
  terms_url                text,
  allows_media_caching     boolean NOT NULL DEFAULT false,
  last_success_at          timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  rate_limited_until       timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- User-configured RSS/Atom feeds (one row per feed, belonging to the 'rss' source)
CREATE TABLE rss_feeds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL UNIQUE,
  title       text,
  enabled     boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- References & permanent identifiers
-- ---------------------------------------------------------------------------
-- The permanent reference number. A sequence is concurrency-safe and never hands out a value
-- twice; rolled-back transactions leave gaps, which is acceptable by design.
CREATE SEQUENCE reference_number_seq AS bigint START 1 NO CYCLE;

CREATE TABLE reference_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_number           bigint NOT NULL UNIQUE DEFAULT nextval('reference_number_seq'),
  original_url         text NOT NULL,
  canonical_url        text NOT NULL UNIQUE,
  source_id            text NOT NULL REFERENCES sources(id),
  source_item_id       text,
  creator_name         text,
  creator_url          text,
  title                text,
  description          text,
  published_raw        text,                         -- date exactly as the source gave it
  published_date       date,                         -- parsed, only when unambiguous
  published_precision  text NOT NULL DEFAULT 'unknown'
                       CHECK (published_precision IN ('day', 'month', 'year', 'decade', 'unknown')),
  discovered_at        timestamptz NOT NULL DEFAULT now(),
  preview_url          text,
  thumbnail_url        text,
  cached_preview_path  text,
  media_type           text NOT NULL DEFAULT 'unknown'
                       CHECK (media_type IN ('image', 'video', 'audio', 'text', 'webpage', 'collection', 'unknown')),
  width                integer CHECK (width IS NULL OR width > 0),
  height               integer CHECK (height IS NULL OR height > 0),
  duration_seconds     numeric CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  license              text,
  rights_statement     text,
  verification_status  text NOT NULL DEFAULT 'source_metadata'
                       CHECK (verification_status IN ('source_metadata', 'editor_verified', 'disputed', 'unverified')),
  attribution_status   text NOT NULL DEFAULT 'source_provided'
                       CHECK (attribution_status IN ('source_provided', 'unknown', 'reported_incorrect', 'editor_confirmed')),
  status               text NOT NULL DEFAULT 'discovered'
                       CHECK (status IN ('discovered', 'saved', 'approved_consideration', 'rejected', 'archived',
                                         'caption_draft', 'reviewed', 'approved_publication', 'manually_published')),
  duplicate_group_id   uuid,
  text_embedding       real[],
  text_embedding_model text,
  visual_hash          text,                         -- perceptual hash when a preview was analysed
  visual_hash_model    text,
  created_by           uuid REFERENCES users(id),
  deleted_at           timestamptz,                  -- tombstone; the number is retired, never reused
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  search_tsv           tsvector GENERATED ALWAYS AS (
                         setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                         setweight(to_tsvector('simple', coalesce(creator_name, '')), 'A') ||
                         setweight(to_tsvector('english', coalesce(description, '')), 'B')
                       ) STORED,
  UNIQUE (source_id, source_item_id)
);
CREATE INDEX reference_items_status_idx ON reference_items(status) WHERE deleted_at IS NULL;
CREATE INDEX reference_items_source_idx ON reference_items(source_id);
CREATE INDEX reference_items_discovered_idx ON reference_items(discovered_at DESC);
CREATE INDEX reference_items_creator_idx ON reference_items(lower(creator_name));
CREATE INDEX reference_items_tsv_idx ON reference_items USING gin(search_tsv);
CREATE INDEX reference_items_dupgroup_idx ON reference_items(duplicate_group_id) WHERE duplicate_group_id IS NOT NULL;

-- The permanent number may never change once assigned.
CREATE FUNCTION forbid_ref_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.ref_number IS DISTINCT FROM OLD.ref_number THEN
    RAISE EXCEPTION 'ref_number is permanent and cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reference_items_ref_number_immutable
  BEFORE UPDATE ON reference_items FOR EACH ROW EXECUTE FUNCTION forbid_ref_number_change();

-- Hard deletes are blocked so numbers cannot be freed; use deleted_at instead.
CREATE FUNCTION forbid_reference_hard_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reference_items rows are never hard-deleted; set deleted_at instead';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reference_items_no_delete
  BEFORE DELETE ON reference_items FOR EACH ROW EXECUTE FUNCTION forbid_reference_hard_delete();

CREATE TABLE reference_tags (
  reference_id uuid NOT NULL REFERENCES reference_items(id),
  tag          text NOT NULL CHECK (length(tag) BETWEEN 1 AND 120),
  origin       text NOT NULL CHECK (origin IN ('source', 'model', 'editor', 'expansion')),
  confidence   real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  state        text NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested', 'confirmed', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, tag, origin)
);
CREATE INDEX reference_tags_tag_idx ON reference_tags(lower(tag));

-- Relationships between references (duplicates, similarity, shared creator)
CREATE TABLE reference_relations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id      uuid NOT NULL REFERENCES reference_items(id),
  to_id        uuid NOT NULL REFERENCES reference_items(id),
  kind         text NOT NULL CHECK (kind IN ('duplicate_candidate', 'confirmed_duplicate', 'not_duplicate',
                                             'visually_similar', 'semantically_related', 'same_creator')),
  score        real,
  method       text NOT NULL,             -- e.g. 'canonical_url', 'title_creator', 'dhash', 'text_embedding'
  evidence     text NOT NULL CHECK (evidence IN ('documented', 'computed', 'editor_confirmed', 'editor_rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id),
  UNIQUE (from_id, to_id, kind)
);

-- ---------------------------------------------------------------------------
-- Cultural entities & knowledge graph
-- ---------------------------------------------------------------------------
CREATE TABLE cultural_entities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('person', 'organization', 'work', 'album', 'film', 'game', 'movement',
                                             'community', 'institution', 'publication', 'technology', 'period',
                                             'location', 'technique', 'concept', 'other')),
  label        text NOT NULL,
  description  text,
  wikidata_id  text UNIQUE CHECK (wikidata_id IS NULL OR wikidata_id ~ '^Q[0-9]+$'),
  external_url text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cultural_entities_label_idx ON cultural_entities(lower(label));

CREATE TABLE reference_entities (
  reference_id  uuid NOT NULL REFERENCES reference_items(id),
  entity_id     uuid NOT NULL REFERENCES cultural_entities(id),
  predicate     text NOT NULL CHECK (predicate IN ('created_by', 'published_in', 'depicts', 'associated_with',
                                                   'appeared_in', 'uses_technique', 'belongs_to_period',
                                                   'related_movement', 'discovered_through')),
  -- documented: stated by a source; inferred: produced by matching/AI; editor_*: human judgement
  evidence      text NOT NULL CHECK (evidence IN ('documented', 'inferred', 'editor_confirmed', 'editor_rejected')),
  confidence    real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  provenance    text NOT NULL,              -- where the claim came from (source field, Wikidata property…)
  provenance_url text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, entity_id, predicate)
);

CREATE TABLE entity_relations (
  from_entity_id uuid NOT NULL REFERENCES cultural_entities(id),
  to_entity_id   uuid NOT NULL REFERENCES cultural_entities(id),
  predicate      text NOT NULL CHECK (predicate IN ('created_by', 'published_in', 'influenced_by', 'associated_with',
                                                    'appeared_in', 'uses_technique', 'belongs_to_period',
                                                    'related_movement', 'part_of', 'instance_of', 'genre')),
  evidence       text NOT NULL CHECK (evidence IN ('documented', 'inferred', 'editor_confirmed', 'editor_rejected')),
  provenance     text NOT NULL,
  provenance_url text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_entity_id, to_entity_id, predicate),
  CHECK (from_entity_id <> to_entity_id)
);

-- ---------------------------------------------------------------------------
-- Editorial decisions, notes, publication records
-- ---------------------------------------------------------------------------
CREATE TABLE editorial_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id    uuid NOT NULL REFERENCES reference_items(id),
  actor_id        uuid REFERENCES users(id),
  decision_type   text NOT NULL CHECK (decision_type IN (
                    'status_change', 'mark_duplicate', 'mark_not_duplicate', 'report_attribution',
                    'report_irrelevant', 'confirm_attribution', 'note_added', 'tag_edit',
                    'relationship_confirm', 'relationship_reject', 'delete', 'restore')),
  reason_code     text,
  -- whether the editor meant this item only or the broader topic/creator/source
  reason_scope    text CHECK (reason_scope IS NULL OR reason_scope IN ('item', 'topic', 'creator', 'source')),
  notes           text,
  previous_status text,
  new_status      text,
  payload         jsonb,
  reverted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX editorial_decisions_ref_idx ON editorial_decisions(reference_id, created_at DESC);
CREATE INDEX editorial_decisions_type_idx ON editorial_decisions(decision_type, created_at DESC);

CREATE TABLE research_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES reference_items(id),
  author_id    uuid REFERENCES users(id),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_notes_ref_idx ON research_notes(reference_id);

-- A manual publication is always reported by the user. There is no code path that publishes.
CREATE TABLE publication_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id  uuid NOT NULL REFERENCES reference_items(id),
  reported_by   uuid REFERENCES users(id),
  platform      text,
  permalink     text,
  published_on  date,
  verification  text NOT NULL DEFAULT 'user_reported' CHECK (verification IN ('user_reported')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Research sources & captions
-- ---------------------------------------------------------------------------
CREATE TABLE research_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id uuid NOT NULL REFERENCES reference_items(id),
  url          text NOT NULL,
  title        text,
  publisher    text,
  kind         text NOT NULL CHECK (kind IN ('original_source', 'creator_page', 'knowledge_base', 'archive',
                                             'article', 'editor_added')),
  excerpt      text,
  added_by     text NOT NULL CHECK (added_by IN ('system', 'editor')),
  accessed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_id, url)
);

CREATE TABLE caption_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id     uuid NOT NULL REFERENCES reference_items(id),
  version          integer NOT NULL CHECK (version > 0),
  parent_draft_id  uuid REFERENCES caption_drafts(id),
  body             text NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('ai_generated', 'grounded_template', 'editor_written', 'editor_edited')),
  provider         text,
  model            text,
  length_setting   text CHECK (length_setting IN ('short', 'medium', 'long')),
  purpose          text,
  tone             text,
  factual_density  text CHECK (factual_density IS NULL OR factual_density IN ('low', 'medium', 'high')),
  emphasis         text,
  research_source_ids uuid[] NOT NULL DEFAULT '{}',
  verification_flags  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{claim, reason}] validated in application
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_id, version)
);

-- The editor's final text lives apart from generated drafts and is only written by the editor.
CREATE TABLE final_captions (
  reference_id     uuid PRIMARY KEY REFERENCES reference_items(id),
  body             text NOT NULL,
  based_on_draft_id uuid REFERENCES caption_drafts(id),
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit, AI usage
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id);

CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  model         text NOT NULL,
  purpose       text NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  succeeded     boolean NOT NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
