package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mostlygeek/llama-swap/internal/event"
	"github.com/mostlygeek/llama-swap/internal/process"
	"github.com/mostlygeek/llama-swap/internal/swaputil"
)

// The upstream queue view (terra fork, patch 33). Radiance publishes its
// scheduler's per-request state at GET /stats: what each request holds in the
// KV pool, and for a waiting one its place in line and why the last admission
// walk passed it over. Every running local model that answers is polled once
// a second and the trimmed snapshots go to UI clients as a "queue" event. A
// model that does not answer (llama-server has no /stats) is skipped for a
// minute rather than asked every second.
//
// requestTagHeader carries the in-flight id upstream (CreateInflightMiddleware)
// and Radiance echoes it as each request's `tag`, which is how the UI joins
// a scheduler row to its in-flight entry: session, client, cancel.

const (
	queuePollInterval = time.Second
	queueRetryAfter   = time.Minute
	requestTagHeader  = "X-Request-Tag"
)

var queuePollClient = &http.Client{Timeout: 2 * time.Second}

// QueueRequest is one scheduler row, in Radiance's /stats spelling.
type QueueRequest struct {
	ID          uint64   `json:"id"`
	Tag         string   `json:"tag,omitempty"`
	State       string   `json:"state"`
	Prompt      int64    `json:"prompt"`
	Computed    int64    `json:"computed"`
	Cached      int64    `json:"cached"`
	Output      int64    `json:"output"`
	Max         int64    `json:"max"`
	KVTokens    int64    `json:"kv_tokens"`
	AgeS        float64  `json:"age_s"`
	TTFTS       *float64 `json:"ttft_s,omitempty"`
	TPS         float64  `json:"tps"`
	Priority    int      `json:"priority"`
	QueuePos    *int     `json:"queue_pos,omitempty"`
	Wait        string   `json:"wait,omitempty"`
	HeldS       *float64 `json:"held_s,omitempty"`
	AdmitTokens int64    `json:"admit_tokens,omitempty"`
}

// QueuePolicy is the admission configuration the snapshot was taken under.
type QueuePolicy struct {
	KVReserve  int64 `json:"kv_reserve"`
	BackfillMs int64 `json:"backfill_ms"`
	AgingS     int64 `json:"aging_s"`
}

// QueueSnapshot is one model's scheduler state at one instant.
type QueueSnapshot struct {
	Model          string         `json:"model"`
	AtMs           int64          `json:"at_ms"`
	KVTokensTotal  int64          `json:"kv_tokens_total"`
	KVTokensUsed   int64          `json:"kv_tokens_used"`
	KVTokensCached int64          `json:"kv_tokens_cached"`
	Running        int            `json:"running"`
	Waiting        int            `json:"waiting"`
	DecodeTPS      float64        `json:"decode_tps"`
	PrefillTPS     float64        `json:"prefill_tps"`
	Preemptions    int64          `json:"preemptions"`
	Policy         *QueuePolicy   `json:"queue,omitempty"`
	Requests       []QueueRequest `json:"requests"`
}

// QueueStatsEvent carries every polled model's latest snapshot; a model
// missing from it has none (unloaded, or not a Radiance upstream).
type QueueStatsEvent struct {
	Snapshots []QueueSnapshot `json:"snapshots"`
}

func (e QueueStatsEvent) Type() uint32 {
	return swaputil.QueueStatsEventID
}

type queueState struct {
	mu    sync.Mutex
	snaps []QueueSnapshot
	skip  map[string]time.Time // model -> when to ask again
}

func (q *queueState) current() QueueStatsEvent {
	q.mu.Lock()
	defer q.mu.Unlock()
	return QueueStatsEvent{Snapshots: append([]QueueSnapshot{}, q.snaps...)}
}

func fetchUpstreamQueue(ctx context.Context, baseURL string) (QueueSnapshot, error) {
	var snap QueueSnapshot
	url := strings.TrimSuffix(baseURL, "/") + "/stats"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return snap, fmt.Errorf("building stats request for %s: %w", url, err)
	}
	resp, err := queuePollClient.Do(req)
	if err != nil {
		return snap, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return snap, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return snap, fmt.Errorf("decoding stats from %s: %w", url, err)
	}
	// Another server's /stats can decode cleanly into nothing; a scheduler
	// always reports its pool.
	if snap.KVTokensTotal <= 0 || snap.Requests == nil {
		return snap, fmt.Errorf("GET %s: not a scheduler snapshot", url)
	}
	return snap, nil
}

func (s *Server) pollQueueOnce(ctx context.Context) {
	now := time.Now()
	var snaps []QueueSnapshot
	for name, state := range s.local.RunningModels() {
		if state != process.StateReady {
			continue
		}
		s.queue.mu.Lock()
		until, skipped := s.queue.skip[name]
		s.queue.mu.Unlock()
		if skipped && now.Before(until) {
			continue
		}
		mc, ok := s.cfg.Models[name]
		if !ok || mc.Proxy == "" {
			continue
		}
		snap, err := fetchUpstreamQueue(ctx, mc.Proxy)
		if err != nil {
			s.logs.ProxyLogs.Debugf("queue poll skipped for %s for %s: %v", name, queueRetryAfter, err)
			s.queue.mu.Lock()
			if s.queue.skip == nil {
				s.queue.skip = make(map[string]time.Time)
			}
			s.queue.skip[name] = now.Add(queueRetryAfter)
			s.queue.mu.Unlock()
			continue
		}
		snap.Model = name
		snap.AtMs = now.UnixMilli()
		snaps = append(snaps, snap)
	}
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].Model < snaps[j].Model })

	s.queue.mu.Lock()
	// Nothing to show twice in a row: stay quiet until a snapshot appears.
	quiet := len(snaps) == 0 && len(s.queue.snaps) == 0
	s.queue.snaps = snaps
	s.queue.mu.Unlock()
	if !quiet {
		event.Emit(QueueStatsEvent{Snapshots: snaps})
	}
}

// runQueuePoller ticks queuePollInterval until shutdownCtx is cancelled.
// With no Radiance model loaded a tick costs a map walk and no request.
func (s *Server) runQueuePoller() {
	ticker := time.NewTicker(queuePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-ticker.C:
			s.pollQueueOnce(s.shutdownCtx)
		}
	}
}
