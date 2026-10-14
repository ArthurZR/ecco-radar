-- Text detected in a reference's image by local OCR. A suggestion until the editor reviews it:
-- only a confirmed or corrected transcription is treated as a fact (for example in Caption Studio).
CREATE TABLE reference_detected_text (
  reference_id    uuid PRIMARY KEY REFERENCES reference_items(id) ON DELETE CASCADE,
  -- outcome of the last run: text found, nothing legible, or the run failed
  outcome         text NOT NULL CHECK (outcome IN ('found', 'none', 'failed')),
  text            text,
  confidence      real,
  word_count      integer NOT NULL DEFAULT 0,
  model           text NOT NULL,
  image_url       text,
  error           text,
  analyzed_at     timestamptz NOT NULL DEFAULT now(),
  review_state    text NOT NULL DEFAULT 'suggested' CHECK (review_state IN ('suggested', 'confirmed', 'corrected', 'rejected')),
  corrected_text  text,
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES users(id),
  CHECK (review_state <> 'corrected' OR corrected_text IS NOT NULL)
);
CREATE INDEX reference_detected_text_search ON reference_detected_text
  USING gin (to_tsvector('simple', coalesce(corrected_text, text, '')))
  WHERE review_state <> 'rejected';
