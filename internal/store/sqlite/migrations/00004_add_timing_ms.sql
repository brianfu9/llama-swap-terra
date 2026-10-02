-- +goose Up
-- -1 marks "no llama-server timings for this row", matching the sentinel
-- buildMetrics stores. Rows written before these columns existed are backfilled
-- to -1 so they render as "unknown" rather than a misleading 0.00s.
ALTER TABLE activity ADD COLUMN prompt_ms INTEGER NOT NULL DEFAULT -1;
ALTER TABLE activity ADD COLUMN predicted_ms INTEGER NOT NULL DEFAULT -1;

-- +goose Down
ALTER TABLE activity DROP COLUMN prompt_ms;
ALTER TABLE activity DROP COLUMN predicted_ms;
