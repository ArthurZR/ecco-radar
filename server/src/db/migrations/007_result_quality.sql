-- Results an exploration run set aside before they reached the feed, counted by reason
-- (no_preview, not_visual, administrative, off_topic), so the editor can see what was filtered.
ALTER TABLE exploration_sessions ADD COLUMN set_aside jsonb NOT NULL DEFAULT '{}'::jsonb;
