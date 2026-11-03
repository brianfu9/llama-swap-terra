-- +goose Up
-- Milliseconds of the decode window (first to last token) the engine spent
-- with this request preempted out of the batch (timings.preempted_ms). The UI
-- subtracts it from predicted_ms to get the active decode time. Engines that
-- do not preempt, and rows written before this column, report 0.
ALTER TABLE activity ADD COLUMN preempted_ms INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE activity DROP COLUMN preempted_ms;
