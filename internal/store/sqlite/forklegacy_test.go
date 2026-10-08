package sqlite

import (
	"context"
	"database/sql"
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

func TestForkLegacyMigrationsRenumbered(t *testing.T) {
	for _, withTsEnd := range []bool{true, false} {
		t.Run(map[bool]string{true: "patch13", false: "patch1-12"}[withTsEnd], func(t *testing.T) {
			ctx := context.Background()
			st, err := New(legacyForkDB(t, withTsEnd))
			if err != nil {
				t.Fatalf("New on a legacy fork database: %v", err)
			}
			defer st.Close()

			cols, err := activityColumns(ctx, st.db)
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range []string{"src", "prompt_ms", "predicted_ms", "ts_end_ms"} {
				if !cols[c] {
					t.Errorf("activity is missing column %s after migration", c)
				}
			}
			var maxV int
			if err := st.db.QueryRowContext(ctx,
				`SELECT MAX(version_id) FROM goose_db_version WHERE is_applied = 1`).Scan(&maxV); err != nil {
				t.Fatal(err)
			}
			if maxV != 5 {
				t.Errorf("max applied version = %d, want 5", maxV)
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
	st, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = New(path)
	if err != nil {
		t.Fatalf("reopen fresh database: %v", err)
	}
	defer st.Close()
	var rows int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM goose_db_version`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 6 {
		t.Errorf("goose_db_version rows = %d, want 6 (versions 0-5, no duplicates)", rows)
	}
}
