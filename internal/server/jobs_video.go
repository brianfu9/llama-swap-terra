package server

// terra fork: the "videos" job kind (see jobs.go).
//
// A backend runs /v1/videos asynchronously: POST returns a job id at once and
// the clip is made in the background. llama-swap only sees the short status
// polls, so between two polls the video model has no request in flight, and a
// queued request for another model swaps it out mid-video.
//
// A video job therefore holds the model: for the whole job it keeps one
// request to the video model in flight, whose response writer blocks until
// the job ends. The scheduler never evicts a model with a request in flight.
// The hold is in place before the job creates the video, so no queued request
// can take the swap in the gap after the create request ends.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var (
	// videoPollInterval is how often a video job asks the backend for status.
	videoPollInterval = 2 * time.Second
	// videoJobTimeout ends a video job that never finishes.
	videoJobTimeout = 30 * time.Minute
	// videoPollFailures is how many failed status polls in a row end a job.
	videoPollFailures = 15
)

var videoFailedStatuses = map[string]bool{"failed": true, "error": true, "cancelled": true, "canceled": true}

// multipartModel returns the "model" field of a multipart/form-data body.
func multipartModel(contentType string, body []byte, kind string) (string, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		return "", fmt.Errorf("a %s job must be multipart/form-data", kind)
	}
	mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("reading the form failed: %v", err)
		}
		if part.FormName() == "model" {
			v, _ := io.ReadAll(io.LimitReader(part, 512))
			if model := strings.TrimSpace(string(v)); model != "" {
				return model, nil
			}
		}
	}
	return "", errors.New("the form has no model")
}

// internalRequest runs one request through the full handler and returns what
// it wrote.
func (s *Server) internalRequest(ctx context.Context, method, path string, header http.Header, body []byte) *jobRecorder {
	rec := &jobRecorder{header: make(http.Header)}
	var rd io.Reader = http.NoBody
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, path, rd)
	if err != nil {
		rec.status = http.StatusInternalServerError
		rec.body.WriteString(err.Error())
		return rec
	}
	req.Header = header.Clone()
	if body == nil {
		req.Header.Del("Content-Type")
	}
	s.handler.ServeHTTP(rec, req)
	return rec
}

// holdWriter is the response writer of a hold request. Its first write marks
// the hold as in place, and every write blocks until the hold is released.
type holdWriter struct {
	header  http.Header
	once    sync.Once
	held    chan struct{}
	release <-chan struct{}
}

func (w *holdWriter) Header() http.Header { return w.header }
func (w *holdWriter) markHeld()           { w.once.Do(func() { close(w.held) }) }
func (w *holdWriter) WriteHeader(code int) {
	if code < 200 {
		return // informational, not the answer
	}
	w.markHeld()
	<-w.release
}
func (w *holdWriter) Write(p []byte) (int, error) {
	w.markHeld()
	<-w.release
	return len(p), nil
}
func (w *holdWriter) Flush() {}

// holdModel keeps one request to model in flight until release is called.
// held closes once the request has been granted (the model is loaded and is
// now protected from eviction) or has ended without a hold.
func (s *Server) holdModel(ctx context.Context, model string, header http.Header) (held <-chan struct{}, release func()) {
	hctx, cancel := context.WithCancel(ctx)
	w := &holdWriter{header: make(http.Header), held: make(chan struct{}), release: hctx.Done()}
	req, err := http.NewRequestWithContext(hctx, http.MethodGet, "/v1/videos?model="+url.QueryEscape(model), http.NoBody)
	if err != nil {
		cancel()
		w.markHeld()
		return w.held, func() {}
	}
	req.Header = header.Clone()
	req.Header.Del("Content-Type")
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer w.markHeld()
		s.handler.ServeHTTP(w, req)
	}()
	return w.held, func() {
		cancel()
		<-done
	}
}

// runVideoJob creates the video, polls it to the end under a hold on the
// model, and writes the clip (or the failure) into rec.
func (s *Server) runVideoJob(j *job, create *http.Request, rec *jobRecorder) {
	ctx, cancel := context.WithTimeout(create.Context(), videoJobTimeout)
	defer cancel()
	header := create.Header

	fail := func(status int, msg string) {
		rec.status = status
		rec.body.Reset()
		rec.body.WriteString(msg)
	}

	held, release := s.holdModel(ctx, j.Model, header)
	defer release()
	select {
	case <-held:
	case <-ctx.Done():
		fail(http.StatusGatewayTimeout, "cancelled while waiting for the video model")
		return
	}

	body, err := io.ReadAll(create.Body)
	if err != nil {
		fail(http.StatusInternalServerError, "reading the job body failed")
		return
	}
	created := s.internalRequest(ctx, http.MethodPost, "/v1/videos", header, body)
	if created.status < 200 || created.status >= 300 {
		fail(created.status, created.body.String())
		return
	}
	var job struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(created.body.Bytes(), &job); job.ID == "" {
		fail(http.StatusBadGateway, "the backend returned no video id: "+created.body.String())
		return
	}
	s.logs.ProxyLogs.Infof("job %s: video %s created on %s", j.ID, job.ID, j.Model)

	q := "?model=" + url.QueryEscape(j.Model)
	base := "/v1/videos/" + url.PathEscape(job.ID)
	defer func() {
		// A cancelled or timed-out job also stops the backend's job.
		if ctx.Err() != nil {
			dctx, dcancel := context.WithTimeout(s.shutdownCtx, 10*time.Second)
			defer dcancel()
			s.internalRequest(dctx, http.MethodDelete, base+q, header, nil)
		}
	}()

	failures := 0
	for {
		select {
		case <-time.After(videoPollInterval):
		case <-ctx.Done():
			fail(http.StatusGatewayTimeout, "the video job was cancelled or timed out")
			return
		}
		st := s.internalRequest(ctx, http.MethodGet, base+q, header, nil)
		if st.status == http.StatusNotFound {
			fail(http.StatusBadGateway, "the backend lost the video job (was the model restarted?)")
			return
		}
		var status struct {
			Status string          `json:"status"`
			Error  json.RawMessage `json:"error"`
		}
		if st.status < 200 || st.status >= 300 || json.Unmarshal(st.body.Bytes(), &status) != nil {
			if ctx.Err() != nil {
				continue
			}
			if failures++; failures >= videoPollFailures {
				fail(http.StatusBadGateway, fmt.Sprintf("video status failed %d times; last: %d %s", failures, st.status, st.body.String()))
				return
			}
			continue
		}
		failures = 0
		switch {
		case status.Status == "completed":
			content := s.internalRequest(ctx, http.MethodGet, base+"/content"+q, header, nil)
			rec.status = content.status
			if rec.status == 0 {
				rec.status = http.StatusOK
			}
			rec.header = content.header
			rec.body.Reset()
			rec.body.Write(content.body.Bytes())
			return
		case videoFailedStatuses[status.Status]:
			msg := "video generation " + status.Status
			if len(status.Error) > 0 && string(status.Error) != "null" {
				msg += ": " + string(status.Error)
			}
			fail(http.StatusBadGateway, msg)
			return
		}
	}
}
