package store

import (
	"math"
	"sort"
	"time"
)

// TokenMetrics holds token usage and performance metrics. Every upstream's
// numbers are normalized to the meanings below; -1 means not reported.
type TokenMetrics struct {
	// CachedTokens is the part of InputTokens served from the prompt cache
	// instead of being processed.
	CachedTokens int `json:"cache_tokens"`
	// DraftTokens is the number of speculative tokens drafted and
	// DraftAccTokens how many of them were accepted.
	DraftTokens    int `json:"draft_tokens"`
	DraftAccTokens int `json:"draft_acc_tokens"`
	// InputTokens is the whole prompt, cached tokens included.
	InputTokens int `json:"input_tokens"`
	// OutputTokens is every generated token, reasoning included.
	OutputTokens int `json:"output_tokens"`
	// ReasoningTokens is the reasoning share of OutputTokens.
	ReasoningTokens int `json:"reasoning_tokens"`
	// PromptPerSecond is the prefill rate: uncached prompt tokens
	// (InputTokens - CachedTokens) per second of prompt processing.
	PromptPerSecond float64 `json:"prompt_per_second"`
	// TokensPerSecond is the decode rate: OutputTokens per second of
	// generation, prefill time excluded.
	TokensPerSecond float64 `json:"tokens_per_second"`
	PromptMs        int     `json:"prompt_ms"`
	PredictedMs     int     `json:"predicted_ms"`
}

// ActivityLogEntry represents parsed token statistics from llama-server logs.
type ActivityLogEntry struct {
	ID        int       `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Src       string    `json:"src"`
	Model     string    `json:"model"`
	// Task is the kind of inference (chat, embedding, ...); see hint.Task.
	Task string `json:"task,omitempty"`
	// Route is "local" or "peer"; PeerID names the peer for peer requests.
	Route           string       `json:"route,omitempty"`
	PeerID          string       `json:"peer_id,omitempty"`
	ReqPath         string       `json:"req_path"`
	RespContentType string       `json:"resp_content_type"`
	RespStatusCode  int          `json:"resp_status_code"`
	Tokens          TokenMetrics `json:"tokens"`
	DurationMs      int          `json:"duration_ms"`
	// CaptureID names this row's request/response capture, or is empty
	// when none was taken. A set CaptureID does not guarantee the capture
	// still exists: captures are pruned by size. HasCapture reports that.
	CaptureID  string            `json:"capture_id,omitempty"`
	HasCapture bool              `json:"has_capture"`
	ErrorMsg   string            `json:"error_msg,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// ActivityFilter narrows which activity rows a query matches. The zero value
// matches every row, and each field is independent: set fields are ANDed.
type ActivityFilter struct {
	Models    []string  // model IN (...); blank entries are ignored, empty matches all models
	Start     time.Time // inclusive lower bound on Timestamp; zero is unbounded
	End       time.Time // inclusive upper bound on Timestamp; zero is unbounded
	MinID     int       // inclusive lower bound on ID; 0 is unbounded
	MaxID     int       // inclusive upper bound on ID; 0 is unbounded
	SrcPrefix string    // literal source prefix; empty matches every source
}

// ActivityQuery selects one page of activity rows.
type ActivityQuery struct {
	ActivityFilter
	Limit int
	Page  int
	Sort  string // sort key from ActivitySortKeys, empty defaults to "id"
	Order string // "asc" or "desc", empty defaults to "desc"
}

// DefaultActivityLimit is the page size used when a query does not set one.
const DefaultActivityLimit = 25

// WithDefaults returns a copy of the query with Page and Limit clamped to
// usable values: Page is at least 1 and Limit defaults to
// DefaultActivityLimit. Repositories apply it before running a query.
func (q ActivityQuery) WithDefaults() ActivityQuery {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.Limit < 1 {
		q.Limit = DefaultActivityLimit
	}
	return q
}

// activitySortKeys whitelists the sortable API keys. Keys mirror the UI
// column ids. Each repository maps them onto its own storage columns, so
// user-supplied sort input never reaches a backend as raw column names.
var activitySortKeys = []string{
	"id",
	"time",
	"model",
	"src",
	"task",
	"req_path",
	"resp_status_code",
	"resp_content_type",
	"cached",
	"prompt",
	"generated",
	"drafted",
	"prompt_speed",
	"gen_speed",
	"prompt_duration",
	"gen_duration",
	"duration",
}

// ActivitySortKeys returns the sort keys accepted by ActivityQuery.Sort.
func ActivitySortKeys() []string {
	return append([]string(nil), activitySortKeys...)
}

// ValidActivitySortKey reports whether key is accepted by ActivityQuery.Sort.
func ValidActivitySortKey(key string) bool {
	for _, k := range activitySortKeys {
		if k == key {
			return true
		}
	}
	return false
}

// ActivityPage is one page of a List result.
type ActivityPage struct {
	Data       []ActivityLogEntry `json:"data"`
	Page       int                `json:"page"`
	Limit      int                `json:"limit"`
	Total      int                `json:"total"`
	TotalPages int                `json:"total_pages"`
}

// TotalPages returns how many pages of size limit are needed for total rows.
// It is zero when there are no rows or the limit is not positive.
func TotalPages(total, limit int) int {
	if total == 0 || limit <= 0 {
		return 0
	}
	return int(math.Ceil(float64(total) / float64(limit)))
}

// ActivityStatsQuery narrows a Stats call. An empty Model matches all models.
type ActivityStatsQuery struct {
	Model string
}

// ActivityStats are aggregate totals and speed histograms over activity rows.
type ActivityStats struct {
	TotalRequests       int                  `json:"total_requests"`
	TotalInputTokens    int                  `json:"total_input_tokens"`
	TotalOutputTokens   int                  `json:"total_output_tokens"`
	TotalCacheTokens    int                  `json:"total_cache_tokens"`
	PromptHistogram     *HistogramData       `json:"prompt_histogram"`
	GenerationHistogram *HistogramData       `json:"gen_histogram"`
	PromptScatter       []PromptScatterPoint `json:"prompt_scatter"`
	GenScatter          []GenScatterPoint    `json:"gen_scatter"`
	// Models lists every model with recorded activity, most recently used
	// first. It deliberately ignores ActivityStatsQuery.Model: the UI's stats
	// model selector needs the full list while a single model is selected.
	Models []ModelActivityCount `json:"models"`
}

// ModelActivityCount is one entry of ActivityStats.Models.
type ModelActivityCount struct {
	ID       string `json:"id"`
	Requests int    `json:"requests"`
}

// PromptScatterPoint is one completed request's prefill speed and the number
// of new prompt tokens it processed, for the speed-vs-length scatter plot.
// PrefillMs is llama-server's measured prompt_ms, or -1 when the request
// reported no timings; it lets the UI weight prompt lengths by the wall-clock
// time they actually cost instead of by request count.
type PromptScatterPoint struct {
	Length    int     `json:"length"`
	Speed     float64 `json:"speed"`
	PrefillMs int     `json:"prefill_ms"`
	Session   string  `json:"session,omitempty"`
}

// GenScatterPoint is one completed request's decode speed against the
// context it was generating over. Accept is the draft acceptance rate,
// or -1 when the request reported no draft tokens. EndMs (unix ms) and
// DecodeMs (llama-server's predicted_ms, -1 when unreported) place the decode
// on the wall clock as [EndMs-DecodeMs, EndMs], so the UI can measure how
// many decodes overlapped and what the system as a whole produced.
type GenScatterPoint struct {
	Context  int     `json:"context"`
	Speed    float64 `json:"speed"`
	Accept   float64 `json:"accept"`
	Output   int     `json:"output"`
	Session  string  `json:"session,omitempty"`
	EndMs    int64   `json:"end_ms"`
	DecodeMs int     `json:"decode_ms"`
}

// HistogramData is a binned distribution with percentile summaries.
type HistogramData struct {
	Bins    []int   `json:"bins"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	BinSize float64 `json:"binSize"`
	P50     float64 `json:"p50"`
	P10     float64 `json:"p10"`
	P1      float64 `json:"p1"`
}

// NewHistogram bins values into between 5 and 20 equal-width buckets (Sturges'
// rule) and computes the p50/p10/p1 percentiles (the slow tail of a speed distribution). It returns nil for no
// values, and a single bucket with a zero BinSize when every value is equal.
// The input is not modified.
func NewHistogram(values []float64) *HistogramData {
	if len(values) == 0 {
		return nil
	}

	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	minVal := sorted[0]
	maxVal := sorted[len(sorted)-1]

	p50 := percentile(sorted, 50)
	p10 := percentile(sorted, 10)
	p1 := percentile(sorted, 1)

	if minVal == maxVal {
		return &HistogramData{
			Bins:    []int{len(values)},
			Min:     minVal,
			Max:     maxVal,
			BinSize: 0,
			P50:     p50,
			P10:     p10,
			P1:      p1,
		}
	}

	const minBins = 5
	const maxBins = 20
	sturges := int(math.Ceil(math.Log2(float64(len(values))))) + 1
	binCount := min(maxBins, max(minBins, sturges))
	binSize := (maxVal - minVal) / float64(binCount)

	bins := make([]int, binCount)
	for _, value := range values {
		idx := min(int(math.Floor((value-minVal)/binSize)), binCount-1)
		bins[idx]++
	}

	return &HistogramData{
		Bins:    bins,
		Min:     minVal,
		Max:     maxVal,
		BinSize: binSize,
		P50:     p50,
		P10:     p10,
		P1:      p1,
	}
}

// percentile linearly interpolates the p-th percentile of sorted values.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	if len(sorted) == 1 {
		return sorted[0]
	}
	rank := (p / 100) * float64(len(sorted)-1)
	lower := int(math.Floor(rank))
	upper := int(math.Ceil(rank))
	fraction := rank - float64(lower)
	return sorted[lower] + fraction*(sorted[upper]-sorted[lower])
}
