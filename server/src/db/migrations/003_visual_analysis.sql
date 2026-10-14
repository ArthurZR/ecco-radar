-- Local visual analysis of preview images (colour/tone vector and perceptual hash).
-- Kept in its own columns so visual and text similarity are never mixed.
ALTER TABLE reference_items
  ADD COLUMN visual_embedding       real[],
  ADD COLUMN visual_embedding_model text,
  ADD COLUMN visual_analyzed_at     timestamptz,
  ADD COLUMN visual_error           text;

CREATE INDEX reference_items_visual_pending_idx ON reference_items (discovered_at)
  WHERE visual_analyzed_at IS NULL AND deleted_at IS NULL;
