-- +goose Up
-- Millisecond wall-clock time the response finished. ts_created only has
-- second resolution, which is too coarse to tell whether two decodes
-- overlapped; the UI rebuilds each decode as [ts_end_ms - predicted_ms,
-- ts_end_ms] to measure concurrency. Older rows are backfilled to the middle
-- of their ts_created second, so their overlap is only accurate to +-0.5s.
ALTER TABLE activity ADD COLUMN ts_end_ms INTEGER NOT NULL DEFAULT 0;
UPDATE activity SET ts_end_ms = ts_created * 1000 + 500;

-- +goose Down
ALTER TABLE activity DROP COLUMN ts_end_ms;
