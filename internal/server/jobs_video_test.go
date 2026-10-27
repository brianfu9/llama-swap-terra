package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mostlygeek/llama-swap/internal/config"
)

// videoBackend is a stub async video backend that records what it sees.
type videoBackend struct {
	mu          sync.Mutex
	events      []string
	polls       int
	pollsToDone int
	finalStatus string
	holdActive  bool
	holdDuring  []bool // holdActive at each status poll
}

func (b *videoBackend) log(e string) {
	b.mu.Lock()
	b.events = append(b.events, e)
	b.mu.Unlock()
}

func (b *videoBackend) snapshot() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.events...)
}

func (b *videoBackend) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/videos":
		b.mu.Lock()
		b.holdActive = true
		b.mu.Unlock()
		b.log("hold start")
		w.WriteHeader(http.StatusMethodNotAllowed) // blocks in the hold writer
		b.mu.Lock()
		b.holdActive = false
		b.mu.Unlock()
		b.log("hold end")
	case r.Method == http.MethodPost && r.URL.Path == "/v1/videos":
		b.log("create")
		w.Write([]byte(`{"id":"vid_1","status":"queued"}`))
	case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/vid_1":
		b.mu.Lock()
		b.polls++
		b.holdDuring = append(b.holdDuring, b.holdActive)
		status := "in_progress"
		if b.polls >= b.pollsToDone {
			status = b.finalStatus
		}
		b.mu.Unlock()
		w.Write([]byte(`{"id":"vid_1","status":"` + status + `"}`))
	case r.Method == http.MethodGet && r.URL.Path == "/v1/videos/vid_1/content":
		b.log("content")
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte("MP4DATA"))
	case r.Method == http.MethodDelete && r.URL.Path == "/v1/videos/vid_1":
		b.log("delete")
		w.Write([]byte(`{}`))
	case r.Method == http.MethodGet && r.URL.Path == "/":
		b.log("reload " + r.Header.Get("X-Test-Model"))
		w.Write([]byte("ok"))
	default:
		b.log("unexpected " + r.Method + " " + r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func newVideoServer(t *testing.T, b *videoBackend) *Server {
	t.Helper()
	old := videoPollInterval
	videoPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { videoPollInterval = old })
	local := newStubRouter([]string{"ltx", "chat"}, "")
	local.serveHTTP = b.serve
	s := newTestServer(local, newStubRouter(nil, ""))
	s.cfg = config.Config{Models: map[string]config.ModelConfig{"ltx": {}, "chat": {}}}
	return s
}

func videoForm(t *testing.T, model string) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("model", model)
	mw.WriteField("prompt", "waves at sunset")
	mw.WriteField("size", "960x544")
	mw.Close()
	return mw.FormDataContentType(), buf.Bytes()
}

func createVideoJobReq(t *testing.T, s *Server, query string) jobView {
	t.Helper()
	ctype, body := videoForm(t, "ltx")
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/videos"+query, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("create: status %d, body %s", w.Code, w.Body.String())
	}
	var v jobView
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestServer_VideoJob_HoldsTheModelUntilTheClipIsFetched(t *testing.T) {
	b := &videoBackend{pollsToDone: 3, finalStatus: "completed"}
	s := newVideoServer(t, b)
	v := createVideoJobReq(t, s, "")
	if v.Model != "ltx" || v.Kind != "videos" {
		t.Fatalf("job %+v", v)
	}
	done := waitJobDone(t, s, "videos", v.ID)
	if done.Status != jobStatusSucceeded || done.ContentType != "video/mp4" || done.Result != nil {
		t.Fatalf("job %+v", done)
	}

	events := b.snapshot()
	want := []string{"hold start", "create", "content", "hold end"}
	if strings.Join(events, ",") != strings.Join(want, ",") {
		t.Fatalf("events %v, want %v", events, want)
	}
	b.mu.Lock()
	for i, held := range b.holdDuring {
		if !held {
			t.Errorf("poll %d ran without the hold", i)
		}
	}
	b.mu.Unlock()

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/jobs/videos/"+v.ID+"/content", nil))
	if w.Code != http.StatusOK || w.Body.String() != "MP4DATA" || w.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("content: %d %q %q", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
}

func TestServer_VideoJob_ReloadsAfterTheClip(t *testing.T) {
	b := &videoBackend{pollsToDone: 1, finalStatus: "completed"}
	s := newVideoServer(t, b)
	v := createVideoJobReq(t, s, "?reload_model=chat")
	waitJobDone(t, s, "videos", v.ID)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ev := b.snapshot()
		if len(ev) > 0 && strings.HasPrefix(ev[len(ev)-1], "reload") {
			if ev[len(ev)-2] != "hold end" {
				t.Fatalf("reload before the hold ended: %v", ev)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no reload: %v", b.snapshot())
}

func TestServer_VideoJob_FailedStatusFailsTheJob(t *testing.T) {
	b := &videoBackend{pollsToDone: 2, finalStatus: "failed"}
	s := newVideoServer(t, b)
	v := createVideoJobReq(t, s, "?reload_model=chat")
	done := waitJobDone(t, s, "videos", v.ID)
	if done.Status != jobStatusFailed || !strings.Contains(done.Error, "video generation failed") {
		t.Fatalf("job %+v", done)
	}
	time.Sleep(30 * time.Millisecond)
	for _, e := range b.snapshot() {
		if strings.HasPrefix(e, "reload") {
			t.Fatalf("reloaded after a failure: %v", b.snapshot())
		}
	}
}

func TestServer_VideoJob_CancelDeletesTheBackendJob(t *testing.T) {
	b := &videoBackend{pollsToDone: 1 << 30, finalStatus: "completed"}
	s := newVideoServer(t, b)
	v := createVideoJobReq(t, s, "")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		polled := b.polls > 0
		b.mu.Unlock()
		if polled {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/jobs/videos/"+v.ID, nil))
	if done := waitJobDone(t, s, "videos", v.ID); done.Status != jobStatusCancelled {
		t.Fatalf("status %q", done.Status)
	}
	events := b.snapshot()
	if !slices.Contains(events, "delete") || !slices.Contains(events, "hold end") {
		t.Fatalf("events %v", events)
	}
}

func TestServer_VideoJob_RejectsABodyWithoutAModel(t *testing.T) {
	s := newVideoServer(t, &videoBackend{})
	for _, tc := range []struct{ ctype, body string }{
		{"application/json", `{"model":"ltx"}`},
		{"multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\nhi\r\n--x--\r\n"},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/jobs/videos", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", tc.ctype)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", tc.ctype, w.Code)
		}
	}
}
