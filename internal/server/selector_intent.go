package server

import (
	"net/http"
	"strings"
	"sync"

	"github.com/mostlygeek/llama-swap/internal/chain"
	"github.com/mostlygeek/llama-swap/internal/config"
	"github.com/mostlygeek/llama-swap/internal/swaputil"
)

// terra fork (patch 34): a request that names a warm selector's target
// directly is a mode switch. While such a request is open, the warm strategy
// sends selector requests to that target.
//
// Without this, the warm strategy picks its target from RunningModels when
// a request arrives. During a switch from target A to target B, the old
// target A is still ready (or stopping, while B is not yet starting), so a
// selector request that arrives in that window picks A, waits in the queue
// behind the switch, and then swaps A back in right after B loads.
//
// Both entry points record intent: the model chain (POST /v1/...) and the
// /upstream/<model>/ passthrough, which the UI's Load button uses.
type selectorIntents struct {
	mu      sync.Mutex
	seq     uint64
	open    map[string]int    // real model ID -> open explicit requests
	lastSeq map[string]uint64 // real model ID -> arrival order of the newest one
	targets map[string]bool   // real model IDs that are warm selector targets
}

func newSelectorIntents(cfg config.Config) *selectorIntents {
	in := &selectorIntents{
		open:    make(map[string]int),
		lastSeq: make(map[string]uint64),
		targets: make(map[string]bool),
	}
	for _, selector := range cfg.Selectors {
		if selector.Strategy != config.SelectorStrategyWarm {
			continue
		}
		for _, target := range selector.Targets {
			if modelID, local := cfg.RealModelName(target); local {
				in.targets[modelID] = true
			}
		}
	}
	return in
}

// begin records an explicit request for model and returns the function that
// ends it. Models that are not warm selector targets are ignored.
func (in *selectorIntents) begin(cfg config.Config, model string) func() {
	if in == nil || len(in.targets) == 0 {
		return func() {}
	}
	modelID, local := cfg.RealModelName(model)
	if !local || !in.targets[modelID] {
		return func() {}
	}
	in.mu.Lock()
	in.seq++
	in.open[modelID]++
	in.lastSeq[modelID] = in.seq
	in.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			in.mu.Lock()
			if in.open[modelID]--; in.open[modelID] <= 0 {
				delete(in.open, modelID)
				delete(in.lastSeq, modelID)
			}
			in.mu.Unlock()
		})
	}
}

// preferred returns the selector target with an open explicit request. When
// more than one target has one, the newest request wins.
func (in *selectorIntents) preferred(cfg config.Config, selector config.SelectorConfig) (string, bool) {
	if in == nil {
		return "", false
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if len(in.open) == 0 {
		return "", false
	}
	best, bestSeq := "", uint64(0)
	for _, target := range selector.Targets {
		modelID, _ := cfg.RealModelName(target)
		if in.open[modelID] > 0 && in.lastSeq[modelID] > bestSeq {
			best, bestSeq = target, in.lastSeq[modelID]
		}
	}
	return best, best != ""
}

// CreateUpstreamSelectorIntentMiddleware records intent for
// /upstream/<model>/... requests (the UI's Load button).
func CreateUpstreamSelectorIntentMiddleware(s *Server) chain.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/upstream/") {
				if _, realName, _, found := swaputil.FindModelInPath(s.cfg, strings.TrimPrefix(r.URL.Path, "/upstream")); found {
					defer s.selectorIntents.begin(s.cfg, realName)()
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
