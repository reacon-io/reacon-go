// Copyright Reacon contributors. Licensed under Apache-2.0.
package reacon

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ErrRequestReplayBlocked means the transport tried to acquire a second
// connection for the same request after the first connection failed.
var ErrRequestReplayBlocked = errors.New("Reacon blocked automatic request replay")

type requestTimeoutKey struct{}

// WithRequestTimeout sets a per-request total network deadline. An earlier
// parent context deadline always wins. Values must be greater than zero.
func WithRequestTimeout(ctx context.Context, timeout time.Duration) context.Context {
	return context.WithValue(ctx, requestTimeoutKey{}, timeout)
}

type RequestTimeoutError struct {
	Duration time.Duration
	Cause    error
}

func (e *RequestTimeoutError) Error() string { return "Reacon request deadline exceeded" }
func (e *RequestTimeoutError) Timeout() bool { return true }
func (e *RequestTimeoutError) Unwrap() error { return e.Cause }

type TransportError struct{ Cause error }

func (e *TransportError) Error() string { return "Reacon request transport failed" }
func (e *TransportError) Unwrap() error { return e.Cause }

type ResponseDecodeError struct {
	StatusCode int
	Headers    http.Header
	Body       []byte
	Cause      error
}

func (e *ResponseDecodeError) Error() string {
	return "Reacon response does not match the declared format"
}
func (e *ResponseDecodeError) Unwrap() error     { return e.Cause }
func (e *ResponseDecodeError) RequestID() string { return e.Headers.Get("X-Request-ID") }
func newResponseDecodeError(response *http.Response, body []byte, cause error) *ResponseDecodeError {
	return &ResponseDecodeError{StatusCode: response.StatusCode, Headers: response.Header.Clone(), Body: body, Cause: cause}
}

func jsonMediaType(value string) bool {
	media, _, err := mime.ParseMediaType(value)
	return err == nil && (media == "application/json" || strings.HasPrefix(media, "application/") && strings.HasSuffix(media, "+json"))
}

func requestFailure(ctx context.Context, timeout time.Duration, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		if errors.Is(cause, ErrRequestReplayBlocked) {
			return &TransportError{Cause: cause}
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &RequestTimeoutError{Duration: timeout, Cause: errors.Join(context.DeadlineExceeded, cause)}
		}
		return errors.Join(context.Canceled, cause)
	}
	var timedOut interface{ Timeout() bool }
	if errors.As(err, &timedOut) && timedOut.Timeout() {
		return &RequestTimeoutError{Duration: timeout, Cause: errors.Join(context.DeadlineExceeded, err)}
	}
	return &TransportError{Cause: err}
}

type deadlineBody struct {
	io.ReadCloser
	ctx     context.Context
	timeout time.Duration
	stop    func()
	once    sync.Once
}

func (b *deadlineBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil {
		if err != io.EOF {
			err = requestFailure(b.ctx, b.timeout, err)
		}
		b.once.Do(b.stop)
	}
	return n, err
}
func (b *deadlineBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.stop)
	return err
}

// configureHTTPPolicy copies the client and clones standard transports. The SDK
// owns that clone's pool; custom RoundTrippers remain caller-owned and must not
// implement retries. HTTP/1 keeps a failed-request replay isolated from other
// multiplexed requests, while still reusing healthy connections.
func configureHTTPPolicy(cfg *Configuration) (*Configuration, *http.Transport) {
	if cfg == nil {
		cfg = NewConfiguration()
	}
	private := *cfg
	client := http.Client{}
	if cfg.HTTPClient != nil {
		client = *cfg.HTTPClient
	}
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	var owned *http.Transport
	if standard, ok := transport.(*http.Transport); ok {
		owned = standard.Clone()
		configureHTTP1Protocols(owned)
		owned.ForceAttemptHTTP2 = false
		owned.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		if owned.TLSClientConfig != nil {
			owned.TLSClientConfig.NextProtos = []string{"http/1.1"}
		}
		client.Transport = owned
	} else {
		client.Transport = transport
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	private.HTTPClient = &client
	return &private, owned
}

// CloseIdleConnections releases this SDK's idle pool without touching a
// caller-owned custom transport. Active calls are cancelled through context.
func (c *APIClient) CloseIdleConnections() {
	if c.ownedTransport != nil {
		c.ownedTransport.CloseIdleConnections()
	}
}

func (c *APIClient) requestWithPolicy(request *http.Request) (*http.Response, error) {
	timeout := c.cfg.RequestTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if override, ok := request.Context().Value(requestTimeoutKey{}).(time.Duration); ok {
		timeout = override
	}
	if timeout <= 0 {
		return nil, errors.New("RequestTimeout must be positive")
	}
	total, stop := context.WithTimeout(request.Context(), timeout)
	ctx, cancel := context.WithCancelCause(total)
	cleanup := func() { cancel(nil); stop() }
	var acquired atomic.Int32
	trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		if acquired.Add(1) > 1 {
			cancel(ErrRequestReplayBlocked)
			// Closing before GotConn returns prevents a subsequent HTTP write,
			// even if a transport cancellation/write select races.
			if info.Conn != nil {
				_ = info.Conn.SetDeadline(time.Now())
				_ = info.Conn.Close()
			}
		}
	}}
	request = request.Clone(httptrace.WithClientTrace(ctx, trace))
	response, err := c.cfg.HTTPClient.Do(request)
	if err != nil {
		failure := requestFailure(ctx, timeout, err)
		cleanup()
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return response, failure
	}
	response.Body = &deadlineBody{ReadCloser: response.Body, ctx: ctx, timeout: timeout, stop: cleanup}
	badStatus := response.StatusCode < 200 || response.StatusCode >= 300
	badType := request.Header.Get("Accept") == "application/json" && !jsonMediaType(response.Header.Get("Content-Type")) && response.StatusCode != http.StatusNoContent
	if badStatus || badType {
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		response.Body = io.NopCloser(bytes.NewReader(body))
		if readErr != nil {
			return response, readErr
		}
		if badStatus {
			var parsed interface{} = string(body)
			if jsonMediaType(response.Header.Get("Content-Type")) {
				var value interface{}
				if json.Unmarshal(body, &value) == nil {
					parsed = value
				}
			}
			return response, &GenericOpenAPIError{body: body, error: fmt.Sprintf("Reacon returned HTTP %d", response.StatusCode), model: parsed, response: response}
		}
		return response, newResponseDecodeError(response, body, errors.New("expected a JSON response"))
	}
	return response, nil
}

// HTTP metadata is also returned as the generated method's *http.Response.
func (e GenericOpenAPIError) StatusCode() int {
	if e.response == nil {
		return 0
	}
	return e.response.StatusCode
}
func (e GenericOpenAPIError) Headers() http.Header {
	if e.response == nil {
		return nil
	}
	return e.response.Header.Clone()
}
func (e GenericOpenAPIError) RequestID() string { return e.Headers().Get("X-Request-ID") }
func (e GenericOpenAPIError) Code() string {
	value, ok := e.model.(map[string]interface{})
	if !ok {
		return ""
	}
	if code, ok := value["code"].(string); ok {
		return code
	}
	if nested, ok := value["error"].(map[string]interface{}); ok {
		if code, ok := nested["code"].(string); ok {
			return code
		}
	}
	return ""
}
