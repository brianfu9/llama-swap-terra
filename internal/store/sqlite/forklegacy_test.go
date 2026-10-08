package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/mostlygeek/llama-swap/internal/store"
)

// legacyForkDB writes a database the way the pre-v262 terra fork left it:
// upstream 00001, then the fork's timing columns recorded as version 2 and,
// when withTsEnd, its ts_end_ms column recorded as version 3.
func legacyForkDB(t *testing.T, withTsEnd bool) string {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	up, err := migrationUp("00001_create_activity.sql")
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE goose_db_version (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version_id INTEGER NOT NULL,
			is_applied INTEGER NOT NULL,
			tstamp TIMESTAMP DEFAULT (datetime('now')))`,
		up,
		`ALTER TABLE activity ADD COLUMN prompt_ms INTEGER NOT NULL DEFAULT -1`,
		`ALTER TABLE activity ADD COLUMN predicted_ms INTEGER NOT NULL DEFAULT -1`,
		`INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, 1), (1, 1), (2, 1)`,
		`INSERT INTO activity (ts_created, model_id, req_path, resp_content_type, resp_status_code,
			cache_tokens, draft_tokens, draft_acc_tokens, input_tokens, output_tokens,
			prompt_per_second, tokens_per_second, duration_ms, error_msg, metadata_json, prompt_ms, predicted_ms)
			VALUES (1700000000, 'sly-abl', '/v1/chat/completions', 'application/json', 200,
			0, 0, 0, 100, 50, 900, 60, 1000, '', '', 110, 830)`,
	}
	if withTsEnd {
		stmts = append(stmts,
			`ALTER TABLE activity ADD COLUMN ts_end_ms INTEGER NOT NULL DEFAULT 0`,
			`UPDATE activity SET ts_end_ms = ts_created * 1000 + 500`,
			`INSERT INTO goose_db_version (version_id, is_applied) VALUES (3, 1)`)
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			t.Fatalf("build legacy db: %v\n%s", err, s)
		}
	}
	return path
}

// v262ForkDB writes a database the way the v262 terra fork (2026-10-08 to
// 2026-11-10) left it: upstream 00001-00003, then the fork's timing columns as
// version 4, ts_end_ms as 5 and, when withPreempted, preempted_ms as 6.
func v262ForkDB(t *testing.T, withPreempted bool) string {
	t.Helper()
	ctx := context.Background()
	path := legacyForkDB(t, true)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	stmts := []string{`DELETE FROM goose_db_version WHERE version_id >= 2`}
	for _, f := range []string{"00002_add_activity_source.sql", "00003_create_cache.sql"} {
		up, err := migrationUp(f)
		if err != nil {
			t.Fatal(err)
		}
		stmts = append(stmts, up)
	}
	stmts = append(stmts, `INSERT INTO goose_db_version (version_id, is_applied) VALUES (2, 1), (3, 1), (4, 1), (5, 1)`)
	if withPreempted {
		stmts = append(stmts,
			`ALTER TABLE activity ADD COLUMN preempted_ms INTEGER NOT NULL DEFAULT 0`,
			`INSERT INTO goose_db_version (version_id, is_applied) VALUES (6, 1)`)
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			t.Fatalf("build v262 fork db: %v\n%s", err, s)
		}
	}
	return path
}

// latestMigration is the highest version among the embedded activity
// migrations, i.e. what every database must reach.
func latestMigration(t *testing.T) (latest, count int) {
	t.Helper()
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		var v int
		if _, err := fmt.Sscanf(e.Name(), "%05d_", &v); err == nil {
			count++
			if v > latest {
				latest = v
			}
		}
	}
	return latest, count
}

func TestForkLegacyMigrationsRenumbered(t *testing.T) {
	cases := map[string]func(t *testing.T) string{
		"pre-v262 patch1-12":    func(t *testing.T) string { return legacyForkDB(t, false) },
		"pre-v262 patch13":      func(t *testing.T) string { return legacyForkDB(t, true) },
		"v262 before patch 29":  func(t *testing.T) string { return v262ForkDB(t, false) },
		"v262 terra 2026-11-10": func(t *testing.T) string { return v262ForkDB(t, true) },
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			latest, count := latestMigration(t)
			if name == "v262 terra 2026-11-10" && latest < 8 {
				t.Skip("preempted_ms is migration 8, added by patch 29")
			}
			st, err := New(build(t), "")
			if err != nil {
				t.Fatalf("New on a legacy fork database: %v", err)
			}
			defer st.Close()

			cols, err := activityColumns(ctx, st.db)
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range []string{"src", "task", "route", "peer_id", "reasoning_tokens", "capture_id", "prompt_ms", "predicted_ms", "ts_end_ms"} {
				if !cols[c] {
					t.Errorf("activity is missing column %s after migration", c)
				}
			}
			var maxV, rows, distinct int
			if err := st.db.QueryRowContext(ctx,
				`SELECT MAX(version_id), COUNT(*), COUNT(DISTINCT version_id) FROM goose_db_version WHERE is_applied = 1`).Scan(&maxV, &rows, &distinct); err != nil {
				t.Fatal(err)
			}
			if maxV != latest {
				t.Errorf("max applied version = %d, want %d", maxV, latest)
			}
			if rows != distinct || rows != count+1 {
				t.Errorf("goose_db_version rows = %d (distinct %d), want %d (versions 0-%d once each)", rows, distinct, count+1, latest)
			}

			// The old row survives with its timings, and the cache table works.
			page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1})
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Data) != 1 || page.Data[0].Tokens.PredictedMs != 830 {
				t.Fatalf("legacy row = %+v", page.Data)
			}
			if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{Timestamp: time.UnixMilli(1_700_000_001_250), Model: "m"}); err != nil {
				t.Fatalf("Insert after migration: %v", err)
			}
			if err := st.Cache().Set(ctx, store.CacheEntry{Key: "k", Data: []byte("v")}); err != nil {
				t.Fatalf("cache Set after migration: %v", err)
			}
		})
	}
}

// A current database must not be touched by the renumbering step.
func TestForkLegacyMigrationsLeaveCurrentDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.db")
	st, err := New(path, "")
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = New(path, "")
	if err != nil {
		t.Fatalf("reopen fresh database: %v", err)
	}
	defer st.Close()
	_, count := latestMigration(t)
	var rows int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM goose_db_version`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != count+1 {
		t.Errorf("goose_db_version rows = %d, want %d (version 0 + each migration once)", rows, count+1)
	}
}
