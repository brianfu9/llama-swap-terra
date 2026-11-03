package sqlite

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/mostlygeek/llama-swap/internal/store"
)

func TestStore_InsertListAndFilterActivity(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	for i, model := range []string{"m1", "m2", "m1"} {
		_, err := st.Activity().Insert(ctx, store.ActivityLogEntry{
			Timestamp: time.Unix(int64(100+i), 0),
			Model:     model,
			ReqPath:   "/v1/chat/completions",
			Tokens: store.TokenMetrics{
				InputTokens:     i + 1,
				OutputTokens:    i + 2,
				PromptPerSecond: float64(10 + i),
				TokensPerSecond: float64(20 + i),
			},
			Metadata: map[string]string{"trace": model},
		})
		if err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}

	page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 2, Page: 1})
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if page.Total != 3 || page.TotalPages != 2 || len(page.Data) != 2 {
		t.Fatalf("page = %+v", page)
	}
	if page.Data[0].ID <= page.Data[1].ID {
		t.Fatalf("activity is not newest first: %+v", page.Data)
	}
	if page.Data[0].Metadata["trace"] != "m1" {
		t.Fatalf("metadata = %+v", page.Data[0].Metadata)
	}

	filtered, err := st.Activity().List(ctx, store.ActivityQuery{
		ActivityFilter: store.ActivityFilter{Models: []string{"m1"}},
		Limit:          10,
		Page:           1,
	})
	if err != nil {
		t.Fatalf("ListActivity filtered: %v", err)
	}
	if filtered.Total != 2 || len(filtered.Data) != 2 {
		t.Fatalf("filtered page = %+v", filtered)
	}
	for _, entry := range filtered.Data {
		if entry.Model != "m1" {
			t.Fatalf("filtered model = %q", entry.Model)
		}
	}
}

// seedFilterActivity inserts 5 rows with ids 1..5 at ts_created 1000..1004,
// alternating models m1/m2/m1/m2/m1, and returns the store.
func seedFilterActivity(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	for i, model := range []string{"m1", "m2", "m1", "m2", "m1"} {
		if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{
			Timestamp: time.Unix(int64(1000+i), 0),
			Model:     model,
		}); err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}
	return st, ctx
}

// entryIDs returns the ids of a page in the order they were returned.
func entryIDs(entries []store.ActivityLogEntry) []int {
	ids := make([]int, len(entries))
	for i, entry := range entries {
		ids[i] = entry.ID
	}
	return ids
}

func equalIDs(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestStore_ListActivityFilterTimeRange(t *testing.T) {
	st, ctx := seedFilterActivity(t)

	tests := []struct {
		name   string
		filter store.ActivityFilter
		want   []int
	}{
		{"start only", store.ActivityFilter{Start: time.Unix(1002, 0)}, []int{5, 4, 3}},
		{"end only", store.ActivityFilter{End: time.Unix(1001, 0)}, []int{2, 1}},
		{"both bounds inclusive", store.ActivityFilter{Start: time.Unix(1001, 0), End: time.Unix(1003, 0)}, []int{4, 3, 2}},
		{"empty range", store.ActivityFilter{Start: time.Unix(9000, 0)}, []int{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := st.Activity().List(ctx, store.ActivityQuery{ActivityFilter: tt.filter, Limit: 10, Page: 1})
			if err != nil {
				t.Fatalf("ListActivity: %v", err)
			}
			if got := entryIDs(page.Data); !equalIDs(got, tt.want) {
				t.Fatalf("ids = %v, want %v", got, tt.want)
			}
			if page.Total != len(tt.want) {
				t.Fatalf("Total = %d, want %d", page.Total, len(tt.want))
			}
		})
	}
}

func TestStore_ListActivityFilterIDRange(t *testing.T) {
	st, ctx := seedFilterActivity(t)

	tests := []struct {
		name   string
		filter store.ActivityFilter
		want   []int
	}{
		{"min only", store.ActivityFilter{MinID: 4}, []int{5, 4}},
		{"max only", store.ActivityFilter{MaxID: 2}, []int{2, 1}},
		{"both bounds inclusive", store.ActivityFilter{MinID: 2, MaxID: 4}, []int{4, 3, 2}},
		{"single row", store.ActivityFilter{MinID: 3, MaxID: 3}, []int{3}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := st.Activity().List(ctx, store.ActivityQuery{ActivityFilter: tt.filter, Limit: 10, Page: 1})
			if err != nil {
				t.Fatalf("ListActivity: %v", err)
			}
			if got := entryIDs(page.Data); !equalIDs(got, tt.want) {
				t.Fatalf("ids = %v, want %v", got, tt.want)
			}
			if page.Total != len(tt.want) {
				t.Fatalf("Total = %d, want %d", page.Total, len(tt.want))
			}
		})
	}
}

func TestStore_ListActivityFilterModels(t *testing.T) {
	st, ctx := seedFilterActivity(t)

	tests := []struct {
		name   string
		models []string
		want   []int
	}{
		{"single", []string{"m1"}, []int{5, 3, 1}},
		{"multiple", []string{"m1", "m2"}, []int{5, 4, 3, 2, 1}},
		{"blank entries ignored", []string{"m2", "  "}, []int{4, 2}},
		{"all blank matches everything", []string{"", " "}, []int{5, 4, 3, 2, 1}},
		{"unknown model", []string{"nope"}, []int{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := st.Activity().List(ctx, store.ActivityQuery{
				ActivityFilter: store.ActivityFilter{Models: tt.models},
				Limit:          10,
				Page:           1,
			})
			if err != nil {
				t.Fatalf("ListActivity: %v", err)
			}
			if got := entryIDs(page.Data); !equalIDs(got, tt.want) {
				t.Fatalf("ids = %v, want %v", got, tt.want)
			}
		})
	}
}

// Combined filters must AND together, and Total/TotalPages must describe the
// filtered set rather than the whole table.
func TestStore_ListActivityFilterCombinedPaging(t *testing.T) {
	st, ctx := seedFilterActivity(t)

	page, err := st.Activity().List(ctx, store.ActivityQuery{
		ActivityFilter: store.ActivityFilter{
			Models: []string{"m1"},
			Start:  time.Unix(1001, 0),
			MinID:  2,
			MaxID:  5,
		},
		Limit: 1,
		Page:  1,
	})
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	// m1 rows are ids 1,3,5; the time and id bounds each drop id 1, leaving
	// 3 and 5.
	if page.Total != 2 || page.TotalPages != 2 {
		t.Fatalf("Total = %d, TotalPages = %d, want 2 and 2", page.Total, page.TotalPages)
	}
	if got := entryIDs(page.Data); !equalIDs(got, []int{5}) {
		t.Fatalf("page 1 ids = %v, want [5]", got)
	}
}

func TestStore_ListActivitySort(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	// Insert rows whose output_tokens ordering differs from insertion (id) order.
	outputs := []int{30, 10, 20}
	for i, out := range outputs {
		if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{
			Timestamp: time.Unix(int64(100+i), 0),
			Model:     "m1",
			Tokens:    store.TokenMetrics{OutputTokens: out},
		}); err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}

	asc, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1, Sort: "generated", Order: "asc"})
	if err != nil {
		t.Fatalf("ListActivity asc: %v", err)
	}
	gotAsc := []int{}
	for _, e := range asc.Data {
		gotAsc = append(gotAsc, e.Tokens.OutputTokens)
	}
	if len(gotAsc) != 3 || gotAsc[0] != 10 || gotAsc[1] != 20 || gotAsc[2] != 30 {
		t.Fatalf("ascending generated sort = %v", gotAsc)
	}

	desc, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1, Sort: "generated", Order: "desc"})
	if err != nil {
		t.Fatalf("ListActivity desc: %v", err)
	}
	gotDesc := []int{}
	for _, e := range desc.Data {
		gotDesc = append(gotDesc, e.Tokens.OutputTokens)
	}
	if len(gotDesc) != 3 || gotDesc[0] != 30 || gotDesc[1] != 20 || gotDesc[2] != 10 {
		t.Fatalf("descending generated sort = %v", gotDesc)
	}

	// Unknown sort keys fall back to id ordering (newest first).
	fallback, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1, Sort: "bogus"})
	if err != nil {
		t.Fatalf("ListActivity fallback: %v", err)
	}
	if fallback.Data[0].ID <= fallback.Data[len(fallback.Data)-1].ID {
		t.Fatalf("fallback sort is not newest first: %+v", fallback.Data)
	}
}

func TestStore_ActivityStats(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	entries := []store.ActivityLogEntry{
		{
			Timestamp: time.UnixMilli(1250),
			Model:     "m1",
			Metadata:  map[string]string{"session": "ses_test1"},
			Tokens: store.TokenMetrics{
				CachedTokens:    2,
				InputTokens:     10,
				OutputTokens:    20,
				PromptPerSecond: 100,
				TokensPerSecond: 50,
				PromptMs:        250,
				PredictedMs:     400,
				DraftTokens:     10,
				DraftAccTokens:  7,
			},
		},
		{
			Timestamp: time.Unix(2, 0),
			Model:     "m1",
			Tokens: store.TokenMetrics{
				CachedTokens:    -1,
				InputTokens:     5,
				OutputTokens:    8,
				PromptPerSecond: 200,
				TokensPerSecond: 100,
				DraftTokens:     0,
			},
		},
		{
			Timestamp: time.Unix(3, 0),
			Model:     "m2",
			Tokens: store.TokenMetrics{
				InputTokens:     7,
				OutputTokens:    9,
				PromptPerSecond: 300,
			},
		},
	}
	for _, entry := range entries {
		if _, err := st.Activity().Insert(ctx, entry); err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}

	stats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{Model: "m1"})
	if err != nil {
		t.Fatalf("ActivityStats: %v", err)
	}
	if stats.TotalRequests != 2 || stats.TotalInputTokens != 15 || stats.TotalOutputTokens != 28 || stats.TotalCacheTokens != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if stats.PromptHistogram == nil || stats.GenerationHistogram == nil {
		t.Fatalf("expected histograms: %+v", stats)
	}
	if len(stats.PromptScatter) != 2 {
		t.Fatalf("expected 2 prompt scatter points, got %+v", stats.PromptScatter)
	}
	promptSessions := map[int]string{}
	for _, p := range stats.PromptScatter {
		promptSessions[p.Length] = p.Session
	}
	if _, ok := promptSessions[10]; !ok {
		t.Fatalf("prompt scatter lengths = %+v, want length 10", stats.PromptScatter)
	}
	if _, ok := promptSessions[5]; !ok {
		t.Fatalf("prompt scatter lengths = %+v, want length 5", stats.PromptScatter)
	}
	promptMs := map[int]int{}
	for _, p := range stats.PromptScatter {
		promptMs[p.Length] = p.PrefillMs
	}
	if promptMs[10] != 250 {
		t.Errorf("prompt scatter prefill_ms for length 10 = %d, want 250", promptMs[10])
	}
	// "No timing" has two spellings: buildMetrics and the 00004 timing migration both
	// write -1, while a TokenMetrics built without PromptMs stores Go's zero.
	// Consumers must treat anything <= 0 as missing, not just -1.
	if promptMs[5] != 0 {
		t.Errorf("prompt scatter prefill_ms for length 5 = %d, want 0 (unset)", promptMs[5])
	}
	if promptSessions[10] != "ses_test1" {
		t.Errorf("prompt scatter session for length 10 = %q, want ses_test1", promptSessions[10])
	}
	if promptSessions[5] != "" {
		t.Errorf("prompt scatter session for length 5 = %q, want empty (no metadata)", promptSessions[5])
	}

	if len(stats.GenScatter) != 2 {
		t.Fatalf("expected 2 gen scatter points, got %+v", stats.GenScatter)
	}
	genByContext := map[int]store.GenScatterPoint{}
	for _, g := range stats.GenScatter {
		genByContext[g.Context] = g
	}
	// Context is input + cache: 10+2 for the first row, 5+(-1) for the second.
	got, ok := genByContext[12]
	if !ok {
		t.Fatalf("gen scatter missing context 12: %+v", stats.GenScatter)
	}
	if got.Speed != 50 || got.Output != 20 || got.Session != "ses_test1" {
		t.Errorf("gen scatter[12] = %+v, want speed 50 output 20 session ses_test1", got)
	}
	if got.Accept != 0.7 {
		t.Errorf("gen scatter[12] accept = %v, want 0.7 (7/10)", got.Accept)
	}
	// ts_end_ms keeps the millisecond part ts_created drops.
	if got.EndMs != 1250 || got.DecodeMs != 400 {
		t.Errorf("gen scatter[12] end_ms/decode_ms = %d/%d, want 1250/400", got.EndMs, got.DecodeMs)
	}
	got, ok = genByContext[4]
	if !ok {
		t.Fatalf("gen scatter missing context 4: %+v", stats.GenScatter)
	}
	if got.Speed != 100 || got.Output != 8 {
		t.Errorf("gen scatter[4] = %+v, want speed 100 output 8", got)
	}
	if got.Accept != -1 {
		t.Errorf("gen scatter[4] accept = %v, want -1 (draft_tokens == 0)", got.Accept)
	}
	if got.Session != "" {
		t.Errorf("gen scatter[4] session = %q, want empty (no metadata)", got.Session)
	}
}

func TestStore_PruneActivity(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	for i := 0; i < 5; i++ {
		if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{Timestamp: time.Unix(int64(i), 0), Model: "m"}); err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}
	if err := st.Activity().Prune(ctx, 2); err != nil {
		t.Fatalf("PruneActivity: %v", err)
	}
	page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1})
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if page.Total != 2 || len(page.Data) != 2 {
		t.Fatalf("page = %+v", page)
	}
	if page.Data[0].ID != 5 || page.Data[1].ID != 4 {
		t.Fatalf("kept IDs = %+v", page.Data)
	}
	stats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{})
	if err != nil {
		t.Fatalf("ActivityStats: %v", err)
	}
	if stats.TotalRequests != 5 {
		t.Fatalf("total requests after prune = %d, want 5", stats.TotalRequests)
	}

	modelStats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{Model: "m"})
	if err != nil {
		t.Fatalf("model ActivityStats: %v", err)
	}
	// terra fork: a model-filtered total is COUNT(*) of retained rows, because
	// MAX(id) is not a per-model count once several models share the table
	// (the stats card's model selector). Only in-memory stores are pruned.
	if modelStats.TotalRequests != 2 {
		t.Fatalf("model total requests after prune = %d, want 2 (retained rows)", modelStats.TotalRequests)
	}
}

func TestStore_NewFilePersistsActivity(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "llama-swap.sqlite")

	st, err := New(path)
	if err != nil {
		t.Fatalf("New file store: %v", err)
	}
	if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{Timestamp: time.Unix(1, 0), Model: "m"}); err != nil {
		t.Fatalf("InsertActivity: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	st, err = New(path)
	if err != nil {
		t.Fatalf("reopen file store: %v", err)
	}
	defer st.Close()
	page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1})
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if page.Total != 1 || len(page.Data) != 1 || page.Data[0].Model != "m" {
		t.Fatalf("page = %+v", page)
	}
	stats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{Model: "m"})
	if err != nil {
		t.Fatalf("ActivityStats: %v", err)
	}
	if stats.TotalRequests != 1 {
		t.Fatalf("total requests = %d, want 1", stats.TotalRequests)
	}
}

func TestStore_NewFileUsesWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "llama-swap.sqlite")
	st, err := New(path)
	if err != nil {
		t.Fatalf("New file store: %v", err)
	}
	defer st.Close()

	var mode string
	if err := st.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}
}

func TestStore_ActivityStatsModels(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	empty, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{})
	if err != nil {
		t.Fatalf("ActivityStats on empty store: %v", err)
	}
	if empty.Models == nil || len(empty.Models) != 0 {
		t.Fatalf("empty store Models = %#v, want non-nil empty slice", empty.Models)
	}

	for i, model := range []string{"m1", "m2", "m1"} {
		if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{
			Timestamp: time.Unix(int64(i+1), 0),
			Model:     model,
			Tokens:    store.TokenMetrics{InputTokens: 10, OutputTokens: 5},
		}); err != nil {
			t.Fatalf("InsertActivity: %v", err)
		}
	}

	// Filtering narrows the totals but never the model list.
	stats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{Model: "m2"})
	if err != nil {
		t.Fatalf("ActivityStats: %v", err)
	}
	if stats.TotalRequests != 1 {
		t.Fatalf("filtered TotalRequests = %d, want 1", stats.TotalRequests)
	}
	want := []store.ModelActivityCount{{ID: "m1", Requests: 2}, {ID: "m2", Requests: 1}}
	if len(stats.Models) != len(want) {
		t.Fatalf("Models = %#v, want %#v", stats.Models, want)
	}
	for i := range want {
		if stats.Models[i] != want[i] {
			t.Fatalf("Models = %#v, want %#v (most recent first)", stats.Models, want)
		}
	}
}

func TestStore_ListActivityKeepsMilliseconds(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{Timestamp: time.UnixMilli(1_700_000_000_250), Model: "m"}); err != nil {
		t.Fatalf("InsertActivity: %v", err)
	}
	page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1})
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if len(page.Data) != 1 {
		t.Fatalf("rows = %d, want 1", len(page.Data))
	}
	// ts_created alone would round this down to ...000; overlap needs the 250ms.
	if got := page.Data[0].Timestamp.UnixMilli(); got != 1_700_000_000_250 {
		t.Errorf("timestamp ms = %d, want 1700000000250", got)
	}
}

// preempted_ms round-trips through Insert, List and the stats gen scatter, and
// a row inserted without it reads back as 0.
func TestStore_ActivityPreemptedMsRoundTrip(t *testing.T) {
	ctx := context.Background()
	st, err := New("")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer st.Close()

	for i, preempted := range []int{0, 350} {
		if _, err := st.Activity().Insert(ctx, store.ActivityLogEntry{
			Timestamp: time.UnixMilli(int64(2000 + i*1000)),
			Model:     "m",
			Tokens: store.TokenMetrics{
				InputTokens:     10 + i,
				OutputTokens:    40,
				TokensPerSecond: 40,
				PredictedMs:     1000,
				PreemptedMs:     preempted,
			},
		}); err != nil {
			t.Fatalf("Insert: %v", err)
		}
	}

	page, err := st.Activity().List(ctx, store.ActivityQuery{Limit: 10, Page: 1, Sort: "id", Order: "asc"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Data) != 2 || page.Data[0].Tokens.PreemptedMs != 0 || page.Data[1].Tokens.PreemptedMs != 350 {
		t.Fatalf("listed preempted_ms = %+v", page.Data)
	}
	if page.Data[1].Tokens.PredictedMs != 1000 {
		t.Fatalf("predicted_ms changed: %+v", page.Data[1].Tokens)
	}

	stats, err := st.Activity().Stats(ctx, store.ActivityStatsQuery{Model: "m"})
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	byContext := map[int]store.GenScatterPoint{}
	for _, g := range stats.GenScatter {
		byContext[g.Context] = g
	}
	if g := byContext[11]; g.PreemptedMs != 350 || g.DecodeMs != 1000 {
		t.Errorf("gen scatter[11] preempted/decode = %d/%d, want 350/1000", g.PreemptedMs, g.DecodeMs)
	}
	if g := byContext[10]; g.PreemptedMs != 0 {
		t.Errorf("gen scatter[10] preempted = %d, want 0", g.PreemptedMs)
	}
}
