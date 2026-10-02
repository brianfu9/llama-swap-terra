package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/mostlygeek/llama-swap/internal/swaputil"
)

const slotPollInterval = 250 * time.Millisecond

var slotPollClient = &http.Client{Timeout: 2 * time.Second}

// upstreamSlot mirrors the subset of llama-server's /slots entries used here.
type upstreamSlot struct {
	ID               int   `json:"id"`
	IsProcessing     bool  `json:"is_processing"`
	NPromptTokens    int64 `json:"n_prompt_tokens"`
	NPromptCache     int64 `json:"n_prompt_tokens_cache"`
	NPromptProcessed int64 `json:"n_prompt_tokens_processed"`
}

func fetchUpstreamSlots(ctx context.Context, baseURL string) ([]upstreamSlot, error) {
	url := strings.TrimSuffix(baseURL, "/") + "/slots"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building slots request for %s: %w", url, err)
	}
	resp, err := slotPollClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	var slots []upstreamSlot
	if err := json.NewDecoder(resp.Body).Decode(&slots); err != nil {
		return nil, fmt.Errorf("decoding slots from %s: %w", url, err)
	}
	return slots, nil
}

func (s *Server) pollSlotsOnce(ctx context.Context) {
	snap := s.inflight.Current()
	if len(snap.Requests) == 0 {
		return
	}

	byModel := make(map[string][]swaputil.InflightRequestEntry)
	for _, entry := range snap.Requests {
		byModel[entry.Model] = append(byModel[entry.Model], entry)
	}

	running := s.local.RunningModels() // map[string]process.ProcessState
	for model, entries := range byModel {
		// CORRELATION RULE: with more than one in-flight request per model there
		// is no reliable way to tell which slot belongs to which request, and a
		// wrong attribution is worse than showing nothing. Skip entirely.
		if len(entries) != 1 {
			continue
		}
		modelCfg, realName, ok := s.cfg.FindConfig(model)
		if !ok {
			continue
		}
		if _, isLocal := running[realName]; !isLocal {
			// peer-routed models have no local upstream to poll
			continue
		}
		if modelCfg.Proxy == "" {
			continue
		}
		slots, err := fetchUpstreamSlots(ctx, modelCfg.Proxy)
		if err != nil {
			s.logs.ProxyLogs.Debugf("slots poll failed for %s: %v", realName, err)
			continue
		}
		var processing []upstreamSlot
		for _, slot := range slots {
			if slot.IsProcessing {
				processing = append(processing, slot)
			}
		}
		// Same correlation reasoning as above: only a single processing slot can
		// be attributed confidently. Zero or more than one means skip.
		if len(processing) == 1 {
			s.inflight.SetSlotTokens(entries[0].ID, processing[0].NPromptTokens,
				processing[0].NPromptCache, processing[0].NPromptProcessed)
		}
	}
}

// runSlotPoller ticks slotPollInterval until shutdownCtx is cancelled. When
// nothing is in flight pollSlotsOnce returns before making any HTTP request,
// so the idle cost is one timer tick.
func (s *Server) runSlotPoller() {
	ticker := time.NewTicker(slotPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-ticker.C:
			s.pollSlotsOnce(s.shutdownCtx)
		}
	}
}
