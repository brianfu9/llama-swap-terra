package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/mostlygeek/llama-swap/internal/config"
	"github.com/mostlygeek/llama-swap/internal/process"
)

// A ready Radiance model is polled and its rows come back with their tags;
// a model that has no /stats is asked once and then left alone for
// queueRetryAfter; a model still starting is not asked at all.
func TestServer_PollQueueOnce(t *testing.T) {
	rad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stats" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"kv_tokens_total":287584,"kv_tokens_used":120000,"kv_tokens_cached":20000,
			"running":1,"waiting":1,"queue":{"kv_reserve":16384,"backfill_ms":60000,"aging_s":30},
			"requests":[
			 {"id":7,"tag":"12","state":"decode","prompt":90000,"kv_tokens":91000,"priority":0,"admit_tokens":107392},
			 {"id":8,"tag":"13","state":"waiting","prompt":150000,"priority":10,"queue_pos":0,"wait":"kv_hold","held_s":4.5,"admit_tokens":166384}]}`))
	}))
	defer rad.Close()
	var cppHits atomic.Int32
	cpp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cppHits.Add(1)
		http.NotFound(w, r)
	}))
	defer cpp.Close()

	local := newStubRouter([]string{"rad", "cpp", "cold"}, "")
	local.running = map[string]process.ProcessState{
		"rad": process.StateReady, "cpp": process.StateReady, "cold": process.StateStarting,
	}
	s := newTestServerWithConfig(config.Config{Models: map[string]config.ModelConfig{
		"rad":  {Proxy: rad.URL},
		"cpp":  {Proxy: cpp.URL},
		"cold": {Proxy: "http://127.0.0.1:1"},
	}}, local, nil)

	s.pollQueueOnce(context.Background())
	got := s.queue.current().Snapshots
	if len(got) != 1 || got[0].Model != "rad" {
		t.Fatalf("snapshots = %+v, want rad only", got)
	}
	snap := got[0]
	if snap.KVTokensTotal != 287584 || snap.Policy == nil || snap.Policy.AgingS != 30 || len(snap.Requests) != 2 {
		t.Fatalf("snapshot = %+v", snap)
	}
	w := snap.Requests[1]
	if w.Tag != "13" || w.Wait != "kv_hold" || w.QueuePos == nil || *w.QueuePos != 0 || w.Priority != 10 ||
		w.HeldS == nil || *w.HeldS != 4.5 || w.AdmitTokens != 166384 {
		t.Errorf("waiting row = %+v", w)
	}

	s.pollQueueOnce(context.Background())
	if n := cppHits.Load(); n != 1 {
		t.Errorf("llama-server /stats asked %d times in two polls, want 1", n)
	}
}

// The in-flight middleware passes its id upstream as X-Request-Tag, and the
// in-flight entry keeps only the client's own headers.
func TestServer_InflightTagsUpstreamRequest(t *testing.T) {
	tracker := newInflightTracker()
	var seen string
	h := CreateInflightMiddleware(tracker, config.Config{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get(requestTagHeader)
		for _, e := range tracker.Current().Requests {
			if _, ok := e.ReqHeaders[requestTagHeader]; ok {
				t.Errorf("in-flight entry %s records the upstream tag header", e.ID)
			}
		}
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if seen != "1" {
		t.Errorf("upstream %s = %q, want the in-flight id 1", requestTagHeader, seen)
	}
}
