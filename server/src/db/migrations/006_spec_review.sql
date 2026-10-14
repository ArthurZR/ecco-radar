-- Per-run processing limits and the explicit relationship to eccö's own history.

-- AI tokens one exploration run may spend (input + output). Searches are already bounded by
-- max_queries; this bounds the only cost RADAR can measure in money terms.
ALTER TABLE exploration_sessions
  ADD COLUMN max_ai_tokens integer NOT NULL DEFAULT 20000 CHECK (max_ai_tokens BETWEEN 0 AND 200000),
  -- close: lean on eccö's captions and approvals; balanced: mix; away: do not expand from them
  ADD COLUMN history_relation text NOT NULL DEFAULT 'balanced' CHECK (history_relation IN ('close', 'balanced', 'away'));

-- Which run spent the tokens, so a run's cost can be shown and capped.
ALTER TABLE ai_usage ADD COLUMN exploration_session_id uuid REFERENCES exploration_sessions(id) ON DELETE SET NULL;
CREATE INDEX ai_usage_session_idx ON ai_usage(exploration_session_id) WHERE exploration_session_id IS NOT NULL;

-- The editor can correct a suggested relationship (not only confirm or reject it), and note edits
-- are kept in the decision history like note additions.
ALTER TABLE editorial_decisions DROP CONSTRAINT editorial_decisions_decision_type_check;
ALTER TABLE editorial_decisions ADD CONSTRAINT editorial_decisions_decision_type_check CHECK (decision_type IN (
  'status_change', 'mark_duplicate', 'mark_not_duplicate', 'report_attribution',
  'report_irrelevant', 'confirm_attribution', 'note_added', 'note_edited', 'tag_edit',
  'relationship_confirm', 'relationship_reject', 'relationship_correct', 'delete', 'restore'));
