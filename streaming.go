// Copyright Reacon contributors. Licensed under Apache-2.0.
package reacon

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	sse "github.com/tmaxmax/go-sse"
)

// VerificationStreamClient owns an isolated streaming transport and per-client credentials.
// Generated JSON resources are separately available through NewAPIClient.
type VerificationStreamClient struct {
	key, baseURL string
	http         *http.Client
	transport    *http.Transport
}

// NewVerificationStreamClient clones the optional transport configuration without owning
// its pool. Streaming uses fresh HTTP/1 connections: Go's transparent replay of GETs on
// a reused connection is inappropriate for a potentially billed verification request.
// TLS verification remains enabled. The normal generated JSON transport is unaffected.
func NewVerificationStreamClient(apiKey, baseURL string, transport *http.Transport) (*VerificationStreamClient, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("apiKey is required")
	}
	if baseURL == "" {
		baseURL = "https://api.reacon.io"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("invalid base URL")
	}
	if transport == nil {
		transport = http.DefaultTransport.(*http.Transport)
	}
	private := transport.Clone()
	private.DisableKeepAlives = true
	private.ForceAttemptHTTP2 = false
	private.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	if private.TLSClientConfig != nil {
		private.TLSClientConfig.NextProtos = []string{"http/1.1"}
	}
	return &VerificationStreamClient{key: apiKey, baseURL: strings.TrimRight(baseURL, "/"), transport: private,
		http: &http.Client{Transport: private, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *VerificationStreamClient) CloseIdleConnections() { c.transport.CloseIdleConnections() }

type VerificationStreamOptions struct {
	OnlyIfFree, CacheMaxAge   string
	IdleTimeout, TotalTimeout time.Duration
	MaxEventBytes             int
}

func (o VerificationStreamOptions) defaults() (VerificationStreamOptions, error) {
	if o.IdleTimeout == 0 {
		o.IdleTimeout = 30 * time.Second
	}
	if o.TotalTimeout == 0 {
		o.TotalTimeout = 5 * time.Minute
	}
	if o.MaxEventBytes == 0 {
		o.MaxEventBytes = 1024 * 1024
	}
	if o.IdleTimeout < 0 || o.TotalTimeout < 0 || o.MaxEventBytes < 1 {
		return o, errors.New("positive timeouts and event limit are required")
	}
	if o.OnlyIfFree != "" && o.OnlyIfFree != "true" && o.OnlyIfFree != "false" {
		return o, errors.New("invalid onlyIfFree")
	}
	if o.CacheMaxAge != "" && o.CacheMaxAge != "live" && o.CacheMaxAge != "1d" && o.CacheMaxAge != "1w" && o.CacheMaxAge != "1m" {
		return o, errors.New("invalid cacheMaxAge")
	}
	return o, nil
}

// VerificationEvent retains the original payload. Exactly one known event pointer is
// non-nil; all are nil for a future event. Kind is local, never a required wire field.
type VerificationEvent struct {
	Kind     string
	Raw      json.RawMessage
	Stage    *VerificationStage
	Progress *VerificationProgress
	Final    *VerificationFinal
}
type StreamProtocolError struct{ Message string }

func (e *StreamProtocolError) Error() string { return e.Message }

type StreamTimeoutError struct{ Phase string }

func (e *StreamTimeoutError) Error() string { return "Reacon " + e.Phase + " timeout" }
func (e *StreamTimeoutError) Timeout() bool { return true }

type StreamTransportError struct{}

func (e *StreamTransportError) Error() string { return "Reacon stream transport failure" }

type StreamAPIError struct {
	Status  int
	Headers http.Header
	Body    json.RawMessage
	Text    string
	Event   *VerificationStreamError
}

func (e *StreamAPIError) Error() string {
	if e.Event != nil {
		return "Reacon stream failed: " + e.Event.Code
	}
	return fmt.Sprintf("Reacon returned HTTP %d", e.Status)
}
func (e *StreamAPIError) RequestID() string { return e.Headers.Get("X-Request-ID") }

type idleStreamReader struct {
	io.Reader
	ctx      context.Context
	cancel   context.CancelCauseFunc
	duration time.Duration
}

func (r idleStreamReader) Read(p []byte) (int, error) {
	timer := time.AfterFunc(r.duration, func() { r.cancel(&StreamTimeoutError{Phase: "idle"}) })
	n, err := r.Reader.Read(p)
	timer.Stop()
	if context.Cause(r.ctx) != nil {
		return n, context.Cause(r.ctx)
	}
	return n, err
}

// StreamVerification is a lazy Go iterator. Breaking iteration closes the HTTP response;
// cancelling ctx interrupts an outstanding network read. It never reconnects or resumes.
func (c *VerificationStreamClient) StreamVerification(ctx context.Context, email string, options VerificationStreamOptions) iter.Seq2[VerificationEvent, error] {
	return func(yield func(VerificationEvent, error) bool) {
		cleanup := func() {}
		fail := func(err error) { cleanup(); yield(VerificationEvent{}, err) }
		settings, err := options.defaults()
		if err != nil {
			fail(err)
			return
		}
		if email == "" {
			fail(errors.New("email is required"))
			return
		}
		total, stop := context.WithTimeoutCause(ctx, settings.TotalTimeout, &StreamTimeoutError{Phase: "total"})
		defer stop()
		requestContext, cancel := context.WithCancelCause(total)
		defer cancel(nil)
		values := url.Values{"email": {email}}
		if settings.OnlyIfFree != "" {
			values.Set("onlyIfFree", settings.OnlyIfFree)
		}
		if settings.CacheMaxAge != "" {
			values.Set("cacheMaxAge", settings.CacheMaxAge)
		}
		request, err := http.NewRequestWithContext(requestContext, http.MethodGet, c.baseURL+"/v1/verify?"+values.Encode(), nil)
		if err != nil {
			fail(errors.New("invalid verification request"))
			return
		}
		request.Header.Set("X-API-Key", c.key)
		request.Header.Set("Accept", "text/event-stream")
		response, err := c.http.Do(request)
		if err != nil {
			if cause := context.Cause(requestContext); cause != nil {
				fail(cause)
			} else {
				fail(&StreamTransportError{})
			}
			return
		}
		cleanup = func() { response.Body.Close(); cancel(nil) }
		defer cleanup()
		reader := idleStreamReader{response.Body, requestContext, cancel, settings.IdleTimeout}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			body, readErr := io.ReadAll(io.LimitReader(reader, 65536))
			if readErr != nil {
				if cause := context.Cause(requestContext); cause != nil {
					fail(cause)
				} else {
					fail(&StreamTransportError{})
				}
				return
			}
			apiError := &StreamAPIError{Status: response.StatusCode, Headers: response.Header.Clone(), Text: string(body)}
			if json.Valid(body) {
				apiError.Body = body
			}
			fail(apiError)
			return
		}
		contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if contentType != "text/event-stream" {
			fail(&StreamProtocolError{"Expected a text/event-stream response body"})
			return
		}
		for item, parseErr := range sse.Read(reader, &sse.ReadConfig{MaxEventSize: settings.MaxEventBytes}) {
			if parseErr != nil {
				if cause := context.Cause(requestContext); cause != nil {
					fail(cause)
				} else if errors.Is(parseErr, io.ErrUnexpectedEOF) {
					fail(&StreamTransportError{})
				} else {
					fail(&StreamProtocolError{"Invalid or interrupted SSE framing"})
				}
				return
			}
			var fields map[string]json.RawMessage
			raw := json.RawMessage(item.Data)
			if json.Unmarshal(raw, &fields) != nil || fields == nil {
				fail(&StreamProtocolError{"Malformed SSE JSON object"})
				return
			}
			event := VerificationEvent{Kind: "unknown", Raw: raw}
			switch {
			case fields["error"] != nil:
				var data VerificationStreamError
				if json.Unmarshal(raw, &data) != nil {
					fail(&StreamProtocolError{"Malformed stream error"})
					return
				}
				fail(&StreamAPIError{Status: response.StatusCode, Headers: response.Header.Clone(), Body: raw, Event: &data})
				return
			case fields["result"] != nil:
				var data VerificationFinal
				if json.Unmarshal(raw, &data) != nil {
					fail(&StreamProtocolError{"Malformed final event"})
					return
				}
				event.Kind = "final"
				event.Final = &data
				response.Body.Close()
				cancel(nil)
				yield(event, nil)
				return
			case fields["stage"] != nil:
				var data VerificationStage
				if json.Unmarshal(raw, &data) != nil {
					fail(&StreamProtocolError{"Malformed stage event"})
					return
				}
				event.Kind = "stage"
				event.Stage = &data
			case fields["state"] != nil:
				var data VerificationProgress
				if json.Unmarshal(raw, &data) != nil {
					fail(&StreamProtocolError{"Malformed progress event"})
					return
				}
				event.Kind = "progress"
				event.Progress = &data
			}
			if !yield(event, nil) {
				return
			}
		}
		if cause := context.Cause(requestContext); cause != nil {
			fail(cause)
		} else {
			fail(&StreamProtocolError{"Verification stream ended before a terminal event"})
		}
	}
}
