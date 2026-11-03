package usage

import (
	"testing"
	"time"

	"github.com/mostlygeek/llama-swap/internal/hint"
)

// terra fork: prompt_ms, predicted_ms (patches 1-11) and preempted_ms
// (patch 29) come from the timings block.
func TestForkTimings(t *testing.T) {
	cases := []struct {
		name                         string
		timings                      string
		wantPrompt, wantPredicted, w int
	}{
		{"present", `{"prompt_ms":110.4,"predicted_ms":1250,"preempted_ms":300.6}`, 110, 1250, 300},
		{"no preempt", `{"prompt_ms":110,"predicted_ms":1250}`, 110, 1250, 0},
		{"negative preempt", `{"prompt_ms":110,"predicted_ms":1250,"preempted_ms":-5}`, 110, 1250, 0},
	}
	for _, up := range []hint.Upstream{hint.Radiance, hint.LlamaServer, hint.Unknown} {
		for _, tc := range cases {
			t.Run(string(up)+"/"+tc.name, func(t *testing.T) {
				body := []byte(`{"usage":{"prompt_tokens":10,"completion_tokens":5},"timings":` + tc.timings + `}`)
				u, err := Extract(up, "/v1/chat/completions", "application/json", body, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				if u.Tokens.PromptMs != tc.wantPrompt || u.Tokens.PredictedMs != tc.wantPredicted || u.Tokens.PreemptedMs != tc.w {
					t.Fatalf("prompt/predicted/preempted = %d/%d/%d, want %d/%d/%d",
						u.Tokens.PromptMs, u.Tokens.PredictedMs, u.Tokens.PreemptedMs, tc.wantPrompt, tc.wantPredicted, tc.w)
				}
			})
		}
	}
	// No timings at all (vLLM, TabbyAPI): times unknown, nothing preempted.
	u, err := Extract(hint.VLLM, "/v1/chat/completions", "application/json", []byte(`{"usage":{"prompt_tokens":1,"completion_tokens":2}}`), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if u.Tokens.PromptMs != -1 || u.Tokens.PredictedMs != -1 || u.Tokens.PreemptedMs != 0 {
		t.Fatalf("without timings: %d/%d/%d, want -1/-1/0", u.Tokens.PromptMs, u.Tokens.PredictedMs, u.Tokens.PreemptedMs)
	}
}
