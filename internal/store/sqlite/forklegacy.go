package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// terra fork: before the v262 rebase (2026-10-08) the fork shipped its own
// migrations as 00002_add_timing_ms and 00003_add_ts_end_ms. Upstream later
// used 00002 and 00003 for add_activity_source and create_cache, and the fork's
// two moved to 00004 and 00005. A database written by the old fork therefore
// records versions 2 and 3 as applied while holding the fork's columns, so
// goose would skip upstream's 00002/00003 and then fail re-adding prompt_ms in
// 00004 -- llama-swap would not start.
//
// renumberForkMigrations detects that layout (prompt_ms present, src absent)
// and, in one transaction, applies upstream's 00002/00003 Up SQL and records
// the fork's columns under their new versions. Any other database is left
// untouched for goose.
func renumberForkMigrations(ctx context.Context, db *sql.DB) error {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'goose_db_version'`).Scan(&n); err != nil {
		return fmt.Errorf("fork migration check: %w", err)
	}
	if n == 0 {
		return nil
	}
	cols, err := activityColumns(ctx, db)
	if err != nil {
		return err
	}
	if !cols["prompt_ms"] || cols["src"] {
		return nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("fork migration renumber: %w", err)
	}
	defer tx.Rollback()

	for _, name := range []string{"00002_add_activity_source.sql", "00003_create_cache.sql"} {
		up, err := migrationUp(name)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, up); err != nil {
			return fmt.Errorf("fork migration renumber: apply %s: %w", name, err)
		}
	}

	// Versions 2 and 3 now mean upstream's migrations (just applied); 4 is the
	// fork's timing columns (present), 5 its ts_end_ms column if it was added.
	versions := []int{4}
	if cols["ts_end_ms"] {
		versions = append(versions, 5)
	}
	for _, v := range []int{2, 3} {
		var applied int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM goose_db_version WHERE version_id = ? AND is_applied = 1`, v).Scan(&applied); err != nil {
			return fmt.Errorf("fork migration renumber: %w", err)
		}
		if applied == 0 {
			versions = append(versions, v)
		}
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
