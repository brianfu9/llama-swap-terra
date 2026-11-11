package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// terra fork: the fork's own activity migrations have moved twice as upstream
// claimed the version numbers they used:
//
//	fork before v262:   2 timing_ms, 3 ts_end_ms
//	fork on v262:       4 timing_ms, 5 ts_end_ms, 6 preempted_ms
//	fork on v272 (now): 6 timing_ms, 7 ts_end_ms, 8 preempted_ms
//
// Upstream now uses 2 (src), 3 (cache table), 4 (task/route/peer_id/
// reasoning_tokens) and 5 (capture_id). goose only compares version numbers,
// so on a database the older fork wrote it would treat upstream's 2-5 as
// applied, skip them, and then fail re-adding prompt_ms -- llama-swap would
// not start.
//
// renumberForkMigrations runs before goose and decides by columns, not by
// recorded versions. When the activity table has the fork's prompt_ms but
// lacks one of upstream's columns, it applies the missing upstream Up
// sections and rewrites goose_db_version to the current numbering, all in one
// transaction, and converts old rows' input_tokens to upstream's meaning.
// goose then applies whatever is still pending. Fresh databases
// and databases already on the current numbering are left untouched.
func renumberForkMigrations(ctx context.Context, db *sql.DB) error {
	if ok, err := tableExists(ctx, db, "goose_db_version"); err != nil || !ok {
		return err
	}
	if ok, err := tableExists(ctx, db, "activity"); err != nil || !ok {
		return err
	}
	cols, err := activityColumns(ctx, db)
	if err != nil {
		return err
	}
	if !cols["prompt_ms"] || (cols["src"] && cols["task"] && cols["capture_id"]) {
		return nil
	}
	hasCache, err := tableExists(ctx, db, "cache")
	if err != nil {
		return err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("fork migration renumber: %w", err)
	}
	defer tx.Rollback()

	upstream := []struct {
		file    string
		present bool
	}{
		{"00002_add_activity_source.sql", cols["src"]},
		{"00003_create_cache.sql", hasCache},
		{"00004_add_activity_task_route.sql", cols["task"]},
		{"00005_add_activity_capture_id.sql", cols["capture_id"]},
	}
	for _, m := range upstream {
		if m.present {
			continue
		}
		up, err := migrationUp(m.file)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, up); err != nil {
			return fmt.Errorf("fork migration renumber: apply %s: %w", m.file, err)
		}
	}

	// Before v272 the fork stored llama-server/Radiance prompt_n alone as
	// input_tokens; upstream now stores the whole prompt (prompt_n + cache_n).
	// Rows with timings (prompt_ms >= 0) get the cached part added once, here,
	// inside the same transaction as the version rewrite.
	if !cols["task"] {
		if _, err := tx.ExecContext(ctx,
			`UPDATE activity SET input_tokens = input_tokens + cache_tokens WHERE prompt_ms >= 0 AND cache_tokens > 0`); err != nil {
			return fmt.Errorf("fork migration renumber: input_tokens: %w", err)
		}
	}

	// Record the current numbering: upstream's 2-5 (now all applied) and the
	// fork's columns that exist. Anything not recorded is pending for goose.
	versions := []int{2, 3, 4, 5, 6}
	if cols["ts_end_ms"] {
		versions = append(versions, 7)
	}
	if cols["preempted_ms"] {
		versions = append(versions, 8)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM goose_db_version WHERE version_id >= 2`); err != nil {
		return fmt.Errorf("fork migration renumber: %w", err)
	}
	for _, v := range versions {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO goose_db_version (version_id, is_applied) VALUES (?, 1)`, v); err != nil {
			return fmt.Errorf("fork migration renumber: record version %d: %w", v, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("fork migration renumber: %w", err)
	}
	return nil
}

func tableExists(ctx context.Context, db *sql.DB, name string) (bool, error) {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n); err != nil {
		return false, fmt.Errorf("fork migration check: %w", err)
	}
	return n > 0, nil
}

func activityColumns(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info('activity')`)
	if err != nil {
		return nil, fmt.Errorf("fork migration check: %w", err)
	}
	defer rows.Close()
	cols := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("fork migration check: %w", err)
		}
		cols[name] = true
	}
	return cols, rows.Err()
}

// migrationUp returns the "-- +goose Up" section of an embedded migration.
func migrationUp(name string) (string, error) {
	data, err := migrationFS.ReadFile("migrations/" + name)
	if err != nil {
		return "", fmt.Errorf("fork migration renumber: %w", err)
	}
	s := string(data)
	start := strings.Index(s, "-- +goose Up")
	end := strings.Index(s, "-- +goose Down")
	if start < 0 || end < start {
		return "", fmt.Errorf("fork migration renumber: %s has no Up section", name)
	}
	return s[start+len("-- +goose Up") : end], nil
}
