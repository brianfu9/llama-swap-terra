package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func createJob(t *testing.T, s *Server, ctx context.Context, kind, body string) jobView {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/"+kind, strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("create: status %d, body %s", w.Code, w.Body.String())
	}
	var v jobView
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("create: decoding %q: %v", w.Body.String(), err)
	}
	return v
}

func getJob(t *testing.T, s *Server, kind, id string) (int, jobView) {
	t.Helper()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/jobs/"+kind+"/"+id, nil))
	var v jobView
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatalf("get: decoding %q: %v", w.Body.String(), err)
		}
	}
	return w.Code, v
}

func waitJobDone(t *testing.T, s *Server, kind, id string) jobView {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		code, v := getJob(t, s, kind, id)
		if code != http.StatusOK {
			t.Fatalf("get: status %d", code)
		}
		if v.Status != jobStatusRunning {
			return v
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job %s still running", id)
	return jobView{}
}

func TestServer_Job_OutlivesTheCreatingRequest(t *testing.T) {
	release := make(chan struct{})
	var gotPath, gotSession string
	local := newStubRouter([]string{"img"}, "")
	local.serveHTTP = func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSession = r.Header.Get("X-Session-ID")
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"b64_json":"AAAA"}]}`))
	}
	s := newTestServer(local, newStubRouter(nil, ""))

	// The client goes away as soon as it has the job id, as a locked phone does.
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/images", strings.NewReader(`{"model":"img","prompt":"a cat"}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-ID", "lspg-abcde")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	cancel()
	if w.Code != http.StatusAccepted {
		t.Fatalf("create: status %d, body %s", w.Code, w.Body.String())
	}
	var created jobView
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.Status != jobStatusRunning || created.Model != "img" || !strings.HasPrefix(created.ID, "job_") {
		t.Fatalf("create: unexpected job %+v", created)
	}

	close(release)
	done := waitJobDone(t, s, "images", created.ID)
	if done.Status != jobStatusSucceeded {
		t.Fatalf("status %q, error %q", done.Status, done.Error)
	}
	if string(done.Result) != `{"data":[{"b64_json":"AAAA"}]}` {
		t.Fatalf("result %s", done.Result)
	}
	if gotPath != "/v1/images/generations" || gotSession != "lspg-abcde" {
		t.Fatalf("upstream saw path %q session %q", gotPath, gotSession)
	}
}

func TestServer_Job_SdapiKindRunsTxt2img(t *testing.T) {
	var gotPath string
	local := newStubRouter([]string{"sd"}, "")
	local.serveHTTP = func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Write([]byte(`{"images":["AAAA"]}`))
	}
	s := newTestServer(local, newStubRouter(nil, ""))

	v := createJob(t, s, context.Background(), "sdapi-txt2img", `{"model":"sd","prompt":"x"}`)
	done := waitJobDone(t, s, "sdapi-txt2img", v.ID)
	if done.Status != jobStatusSucceeded || gotPath != "/sdapi/v1/txt2img" {
		t.Fatalf("status %q path %q", done.Status, gotPath)
	}
}

func TestServer_Job_UpstreamErrorFails(t *testing.T) {
	local := newStubRouter([]string{"img"}, "")
	local.serveHTTP = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`size must be a multiple of 32`))
	}
	s := newTestServer(local, newStubRouter(nil, ""))

	v := createJob(t, s, context.Background(), "images", `{"model":"img","prompt":"x"}`)
	done := waitJobDone(t, s, "images", v.ID)
	if done.Status != jobStatusFailed || done.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %q code %d", done.Status, done.StatusCode)
	}
	if !strings.Contains(done.Error, "multiple of 32") || done.Result != nil {
		t.Fatalf("error %q result %s", done.Error, done.Result)
	}
}

func TestServer_Job_DeleteCancelsTheUpstreamRequest(t *testing.T) {
	started := make(chan struct{})
	upstreamCancelled := make(chan struct{})
	local := newStubRouter([]string{"img"}, "")
	local.serveHTTP = func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(upstreamCancelled)
	}
	s := newTestServer(local, newStubRouter(nil, ""))

	v := createJob(t, s, context.Background(), "images", `{"model":"img","prompt":"x"}`)
	<-started
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/jobs/images/"+v.ID, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("delete: status %d", w.Code)
	}
	select {
	case <-upstreamCancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request was not cancelled")
	}
	if done := waitJobDone(t, s, "images", v.ID); done.Status != jobStatusCancelled {
		t.Fatalf("status %q", done.Status)
	}

	// A second delete forgets the finished job.
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/jobs/images/"+v.ID, nil))
	if code, _ := getJob(t, s, "images", v.ID); code != http.StatusNotFound {
		t.Fatalf("after second delete: status %d", code)
	}
}

func TestServer_Job_RejectsBadRequests(t *testing.T) {
	s := newTestServer(newStubRouter([]string{"img"}, ""), newStubRouter(nil, ""))
	for _, tc := range []struct {
		kind, body string
		want       int
	}{
		{"videos", `{"model":"img"}`, http.StatusNotFound},
		{"images", `not json`, http.StatusBadRequest},
		{"images", `{"prompt":"no model"}`, http.StatusBadRequest},
		{"images", `{"model":"img","prompt":"` + strings.Repeat("x", jobMaxBody) + `"}`, http.StatusRequestEntityTooLarge},
	} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/jobs/"+tc.kind, strings.NewReader(tc.body)))
		if w.Code != tc.want {
			t.Errorf("%s %.40s: status %d, want %d", tc.kind, tc.body, w.Code, tc.want)
		}
	}
	if code, _ := getJob(t, s, "images", "job_missing"); code != http.StatusNotFound {
		t.Errorf("missing job: status %d", code)
	}
}

func TestJobStore_PruneKeepsRunningAndDropsOldOrExcessFinished(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	st := newJobStore()
	st.now = func() time.Time { return now }
	st.jobs["running"] = &job{ID: "running", Status: jobStatusRunning, CreatedAt: now.Add(-3 * time.Hour)}
	st.jobs["expired"] = &job{ID: "expired", Status: jobStatusSucceeded, FinishedAt: now.Add(-jobRetention - time.Minute)}
	for i := 0; i < jobMaxFinished+2; i++ {
		id := fmt.Sprintf("f%02d", i)
		st.jobs[id] = &job{ID: id, Status: jobStatusSucceeded, FinishedAt: now.Add(-time.Duration(30-i) * time.Minute)}
	}

	st.pruneLocked()

	if _, ok := st.jobs["running"]; !ok {
		t.Error("running job was dropped")
	}
	if _, ok := st.jobs["expired"]; ok {
		t.Error("expired job was kept")
	}
	for _, id := range []string{"f00", "f01"} {
		if _, ok := st.jobs[id]; ok {
			t.Errorf("oldest finished job %s was kept", id)
		}
	}
	if len(st.jobs) != jobMaxFinished+1 {
		t.Errorf("kept %d jobs, want %d", len(st.jobs), jobMaxFinished+1)
	}
}
