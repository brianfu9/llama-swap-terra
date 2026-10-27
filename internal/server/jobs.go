package server

// terra fork: background jobs for the playground's synchronous image
// endpoints.
//
// A phone that locks or backgrounds the browser drops its connection, and an
// image request that was still running is cancelled with it: the reverse proxy
// ties the upstream request to the client's context. A job runs the same
// request inside llama-swap instead, on a context that only the job's own
// cancel and server shutdown end, and keeps the response for the client to
// fetch when it comes back.
//
// The job replays the request through s.handler, so it goes through the same
// auth, model swap, inflight tracking and activity log as a direct request.
//
// A body may carry "reload_model": after the job succeeds, and when no other
// job is still running, the job loads that model again (GET /upstream/<id>/,
// as the UI's Load button does). The Chat tab uses it to bring its chat model
// back while a locked phone is not polling. The field is removed before the
// body is forwarded.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"

	"github.com/mostlygeek/llama-swap/internal/swaputil"
)

// jobKinds maps the {kind} path value to the synchronous endpoint a job runs.
var jobKinds = map[string]string{
	"images":        "/v1/images/generations",
	"sdapi-txt2img": "/sdapi/v1/txt2img",
}

const (
	jobStatusRunning   = "running"
	jobStatusSucceeded = "succeeded"
	jobStatusFailed    = "failed"
	jobStatusCancelled = "cancelled"

	// jobRetention is how long a finished job stays fetchable.
	jobRetention = time.Hour
	// jobMaxFinished caps how many finished jobs are kept. A result holds
	// base64 pictures (several MB each at 2048x2048), so the oldest go first.
	jobMaxFinished = 8
	// jobMaxBody caps a job's request body.
	jobMaxBody = 1 << 20
)

type job struct {
	ID         string
	Kind       string
	Model      string
	Status     string
	CreatedAt  time.Time
	FinishedAt time.Time
	StatusCode int
	Body       []byte
	Error      string
	// ReloadModel is loaded again after the job succeeds (see above).
	ReloadModel string
	cancel      context.CancelFunc
	// cancelled is set by a DELETE while the job runs. Status stays
	// running until runJob records the end, so pruning never sees a
	// finished job without a FinishedAt.
	cancelled bool
}

// jobView is the JSON shape of a job. Result carries the upstream response
// body unchanged when it is JSON.
type jobView struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Model      string          `json:"model"`
	Status     string          `json:"status"`
	CreatedAt  time.Time       `json:"created_at"`
	FinishedAt *time.Time      `json:"finished_at,omitempty"`
	StatusCode int             `json:"status_code,omitempty"`
	Error      string          `json:"error,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
}

type jobStore struct {
	mu   sync.Mutex
	jobs map[string]*job
	now  func() time.Time
}

func newJobStore() *jobStore {
	return &jobStore{jobs: make(map[string]*job), now: time.Now}
}

func (st *jobStore) view(j *job, withResult bool) jobView {
	v := jobView{
		ID:         j.ID,
		Kind:       j.Kind,
		Model:      j.Model,
		Status:     j.Status,
		CreatedAt:  j.CreatedAt,
		StatusCode: j.StatusCode,
		Error:      j.Error,
	}
	if !j.FinishedAt.IsZero() {
		t := j.FinishedAt
		v.FinishedAt = &t
	}
	if withResult && j.Status == jobStatusSucceeded && json.Valid(j.Body) {
		v.Result = j.Body
	}
	return v
}

// pruneLocked drops finished jobs past jobRetention, then the oldest finished
// jobs beyond jobMaxFinished. Running jobs are never dropped.
func (st *jobStore) pruneLocked() {
	now := st.now()
	var finished []*job
	for id, j := range st.jobs {
		if j.Status == jobStatusRunning {
			continue
		}
		if now.Sub(j.FinishedAt) > jobRetention {
			delete(st.jobs, id)
			continue
		}
		finished = append(finished, j)
	}
	if len(finished) <= jobMaxFinished {
		return
	}
	sort.Slice(finished, func(a, b int) bool { return finished[a].FinishedAt.Before(finished[b].FinishedAt) })
	for _, j := range finished[:len(finished)-jobMaxFinished] {
		delete(st.jobs, j.ID)
	}
}

func newJobID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "job_" + hex.EncodeToString(b)
}

// jobRecorder is the ResponseWriter a job's replayed request writes into.
type jobRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *jobRecorder) Header() http.Header { return r.header }
func (r *jobRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
}
func (r *jobRecorder) Write(p []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(p)
}
func (r *jobRecorder) Flush() {}

// handleAPIJobCreate starts a job and answers 202 with its id at once.
func (s *Server) handleAPIJobCreate(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	path, ok := jobKinds[kind]
	if !ok {
		swaputil.SendResponse(w, r, http.StatusNotFound, "unknown job kind")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, jobMaxBody+1))
	if err != nil {
		swaputil.SendResponse(w, r, http.StatusBadRequest, "reading the request body failed")
		return
	}
	if len(body) > jobMaxBody {
		swaputil.SendResponse(w, r, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	var probe struct {
		Model       string `json:"model"`
		ReloadModel string `json:"reload_model"`
	}
	if err := json.Unmarshal(body, &probe); err != nil || probe.Model == "" {
		swaputil.SendResponse(w, r, http.StatusBadRequest, "the body must be JSON with a model")
		return
	}
	if probe.ReloadModel != "" {
		// Backends refuse fields they do not know, so reload_model stops here.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			swaputil.SendResponse(w, r, http.StatusBadRequest, "the body must be a JSON object")
			return
		}
		delete(fields, "reload_model")
		if body, err = json.Marshal(fields); err != nil {
			swaputil.SendResponse(w, r, http.StatusInternalServerError, "re-encoding the body failed")
			return
		}
	}

	ctx, cancel := context.WithCancel(s.shutdownCtx)
	inner, err := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		cancel()
		swaputil.SendResponse(w, r, http.StatusInternalServerError, "building the job request failed")
		return
	}
	// Auth and the playground session id travel in the headers.
	inner.Header = r.Header.Clone()
	inner.Header.Set("Content-Type", "application/json")
	inner.Header.Del("Content-Length")
	inner.Header.Del("Accept-Encoding")
	inner.RemoteAddr = r.RemoteAddr
	inner.Host = r.Host

	st := s.jobs
	j := &job{
		ID:          newJobID(),
		Kind:        kind,
		Model:       probe.Model,
		Status:      jobStatusRunning,
		CreatedAt:   st.now(),
		ReloadModel: probe.ReloadModel,
		cancel:      cancel,
	}
	st.mu.Lock()
	st.pruneLocked()
	st.jobs[j.ID] = j
	view := st.view(j, false)
	st.mu.Unlock()

	go s.runJob(j, inner)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(view)
}

func (s *Server) runJob(j *job, inner *http.Request) {
	defer j.cancel()
	rec := &jobRecorder{header: make(http.Header)}
	func() {
		defer func() {
			if p := recover(); p != nil {
				s.logs.ProxyLogs.Errorf("job %s panicked: %v", j.ID, p)
				rec.status = http.StatusInternalServerError
				rec.body.Reset()
				rec.body.WriteString("internal error")
			}
		}()
		s.handler.ServeHTTP(rec, inner)
	}()

	st := s.jobs
	st.mu.Lock()
	j.FinishedAt = st.now()
	j.StatusCode = rec.status
	switch {
	case j.cancelled || inner.Context().Err() != nil:
		j.Status = jobStatusCancelled
	case rec.status >= 200 && rec.status < 300:
		j.Status = jobStatusSucceeded
		j.Body = rec.body.Bytes()
	default:
		j.Status = jobStatusFailed
		j.Error = rec.body.String()
	}
	s.logs.ProxyLogs.Infof("job %s (%s, %s) %s after %s", j.ID, j.Kind, j.Model, j.Status, j.FinishedAt.Sub(j.CreatedAt).Round(time.Millisecond))
	reload := j.ReloadModel != "" && j.Status == jobStatusSucceeded && !st.otherRunningLocked(j.ID)
	st.mu.Unlock()

	if reload {
		s.reloadAfterJob(j, inner.Header)
	}
}

// otherRunningLocked reports whether a job other than id is still running. A
// reload then would swap the media model out from under it; the last job to
// finish does the reload instead.
func (st *jobStore) otherRunningLocked(id string) bool {
	for other, j := range st.jobs {
		if other != id && j.Status == jobStatusRunning {
			return true
		}
	}
	return false
}

// reloadAfterJob loads j.ReloadModel through the normal handler, with the
// job's own auth headers. The result only goes to the log: the picture is
// already stored, and a failed reload just means the next chat loads the
// model itself.
func (s *Server) reloadAfterJob(j *job, header http.Header) {
	req, err := http.NewRequestWithContext(s.shutdownCtx, http.MethodGet, "/upstream/"+url.PathEscape(j.ReloadModel)+"/", http.NoBody)
	if err != nil {
		return
	}
	req.Header = header.Clone()
	req.Header.Del("Content-Type")
	rec := &jobRecorder{header: make(http.Header)}
	s.handler.ServeHTTP(rec, req)
	s.logs.ProxyLogs.Infof("job %s: reloaded %s after the job, status %d", j.ID, j.ReloadModel, rec.status)
}

// handleAPIJobGet returns a job, with its result once it has succeeded.
func (s *Server) handleAPIJobGet(w http.ResponseWriter, r *http.Request) {
	st := s.jobs
	st.mu.Lock()
	st.pruneLocked()
	j, ok := st.jobs[r.PathValue("id")]
	var view jobView
	if ok {
		view = st.view(j, true)
	}
	st.mu.Unlock()
	if !ok {
		swaputil.SendResponse(w, r, http.StatusNotFound, "job not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(view)
}

// handleAPIJobDelete cancels a running job, or forgets a finished one.
func (s *Server) handleAPIJobDelete(w http.ResponseWriter, r *http.Request) {
	st := s.jobs
	st.mu.Lock()
	j, ok := st.jobs[r.PathValue("id")]
	if ok {
		if j.Status == jobStatusRunning {
			j.cancelled = true
			j.cancel()
		} else {
			delete(st.jobs, j.ID)
		}
	}
	st.mu.Unlock()
	if !ok {
		swaputil.SendResponse(w, r, http.StatusNotFound, "job not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"msg": "ok"})
}
