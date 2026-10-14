-- One run of the Instagram export importer, so it can be undone as a whole.
CREATE TABLE post_media_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text NOT NULL,
  account      text,
  summary      jsonb NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Images of eccö's own published posts, supplied by the editor (Instagram "Download your
-- information" export or a single upload). Analytics exports carry no media, so a post without a
-- row here has text-only evidence. Only a downscaled copy is kept (files under MEDIA_DIR); the
-- analysis is the same local colour-tone-v1 + dhash-64 used for references.
CREATE TABLE historical_post_media (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid NOT NULL REFERENCES historical_posts(id) ON DELETE CASCADE,
  origin           text NOT NULL CHECK (origin IN ('instagram_export', 'upload')),
  import_id        uuid REFERENCES post_media_imports(id) ON DELETE CASCADE,
  -- position within a carousel (0 for single images)
  position         integer NOT NULL DEFAULT 0,
  -- sha256 of the original file bytes, so the same image is never attached twice to a post
  sha256           text NOT NULL,
  file_name        text NOT NULL,
  original_name    text,
  width            integer NOT NULL,
  height           integer NOT NULL,
  visual_hash      text NOT NULL,
  visual_hash_model text NOT NULL,
  visual_embedding real[] NOT NULL,
  visual_model     text NOT NULL,
  -- pixel means in 0..1 (luminance, saturation), measured on the same sample as the vector
  mean_luminance   real NOT NULL,
  mean_saturation  real NOT NULL,
  -- how the image was tied to the post, in words the editor can check
  match_note       text NOT NULL,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, sha256),
  UNIQUE (file_name)
);
CREATE INDEX historical_post_media_post ON historical_post_media(post_id);

ALTER TABLE historical_post_features DROP CONSTRAINT historical_post_features_feature_kind_check;
ALTER TABLE historical_post_features ADD CONSTRAINT historical_post_features_feature_kind_check
  CHECK (feature_kind IN ('topic', 'term', 'hashtag', 'mention', 'period', 'caption_length', 'format', 'tone', 'colourfulness'));
