package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	reacon "github.com/reacon-io/reacon-go"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

func check(value bool, message string) {
	if !value {
		panic(message)
	}
}

var options = reacon.VerificationStreamOptions{OnlyIfFree: "true"}

func collect(client *reacon.VerificationStreamClient, scenario string, settings reacon.VerificationStreamOptions) ([]reacon.VerificationEvent, error) {
	var events []reacon.VerificationEvent
	for event, err := range client.StreamVerification(context.Background(), scenario+"@example.test", settings) {
		if err != nil {
			return events, err
		}
		events = append(events, event)
	}
	return events, nil
}
func main() {
	url := os.Getenv("REACON_TEST_URL")
	client, err := reacon.NewVerificationStreamClient("synthetic-go", fixtureTransport(url, nil))
	if err != nil {
		panic(err)
	}
	isolated, err := reacon.NewVerificationStreamClient("isolated-go", fixtureTransport(url, nil))
	if err != nil {
		panic(err)
	}
	defer client.CloseIdleConnections()
	defer isolated.CloseIdleConnections()
	_ = client.StreamVerification(context.Background(), "never@example.test", options)
	var group sync.WaitGroup
	for scenario, owner := range map[string]*reacon.VerificationStreamClient{"success": client, "isolated": isolated} {
		group.Add(1)
		go func() {
			defer group.Done()
			events, err := collect(owner, scenario, options)
			if err != nil {
				panic(err)
			}
			check(len(events) == 4 && events[0].Stage != nil && events[1].Kind == "unknown" && events[2].Progress != nil && events[3].Final != nil, "event classification")
			var raw map[string]interface{}
			json.Unmarshal(events[0].Raw, &raw)
			check(raw["label"] == "hé🚀", "split UTF-8")
			check(events[3].Final.Result.AcceptsAll.Get() == nil && events[3].Final.Result.Status == "future-status", "typed final")
		}()
	}
	group.Wait()
	_, err = collect(client, "error", options)
	var apiError *reacon.StreamAPIError
	check(errors.As(err, &apiError) && apiError.Status == 200 && apiError.Event.Code == "INSUFFICIENT_CREDITS" && *apiError.Event.RemainingCredits == 0 && apiError.RequestID() == "req-stream", "terminal error metadata")
	for scenario, status := range map[string]int{"pre402": 402, "pre429": 429, "proxy": 502, "redirect": 307} {
		_, err = collect(client, scenario, options)
		apiError = nil
		check(errors.As(err, &apiError) && apiError.Status == status, "HTTP status")
		if status == 402 || status == 429 {
			var raw map[string]interface{}
			json.Unmarshal(apiError.Body, &raw)
			check(raw["code"] == "FIXTURE_ERROR" && apiError.RequestID() == "req-stream", "HTTP metadata")
		}
		if status == 502 {
			check(apiError.RequestID() == "" && apiError.Body == nil && apiError.Text != "", "proxy error")
		}
	}
	for _, scenario := range []string{"wrongtype", "malformed", "invalidresult", "eof"} {
		_, err = collect(client, scenario, options)
		var protocol *reacon.StreamProtocolError
		check(errors.As(err, &protocol), "protocol "+scenario)
	}
	_, err = collect(client, "disconnect", options)
	var transport *reacon.StreamTransportError
	check(errors.As(err, &transport), fmt.Sprintf("transport: %v", err))
	for _, phase := range []string{"idle", "total", "headers"} {
		_, err = collect(client, phase, reacon.VerificationStreamOptions{OnlyIfFree: "true", IdleTimeout: 80 * time.Millisecond, TotalTimeout: 200 * time.Millisecond})
		var timeout *reacon.StreamTimeoutError
		check(errors.As(err, &timeout), fmt.Sprintf("timeout: %v", err))
		if phase != "headers" {
			check(timeout.Phase == phase, "timeout phase")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	seen := false
	for event, err := range client.StreamVerification(ctx, "cancel@example.test", options) {
		if err != nil {
			check(seen && errors.Is(err, context.Canceled), "cancellation")
			break
		}
		check(event.Stage != nil, "cancel first stage")
		seen = true
		time.AfterFunc(20*time.Millisecond, cancel)
	}
	cancel()
	for event, err := range client.StreamVerification(context.Background(), "early@example.test", options) {
		check(err == nil && event.Stage != nil, "early stage")
		break
	}
	response, err := http.Get(url + "/_assert_closed")
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()
	check(response.StatusCode == 200, "closure while client remains alive")
	fmt.Println("Go streaming protocol, cancellation and live closure assertions passed")
}

// fixtureTransport preserves the SDK's fixed origin and redirects only at the test HTTP transport.
func fixtureTransport(target string, original *http.Transport) *http.Transport {
	if original == nil {
		original = http.DefaultTransport.(*http.Transport)
	}
	transport := original.Clone()
	fixture, err := url.Parse(target)
	if err != nil {
		panic(err)
	}
	if fixture.Hostname() != "127.0.0.1" && fixture.Hostname() != "localhost" {
		panic("Loopback fixtures only")
	}
	proxy, err := url.Parse(os.Getenv("REACON_FIXTURE_PROXY_ENDPOINT"))
	if err != nil || proxy.Host == "" {
		panic("Fixture proxy required")
	}
	password, _ := proxy.User.Password()
	proxy.User = url.UserPassword(base64.RawURLEncoding.EncodeToString([]byte(target)), password)
	transport.Proxy = http.ProxyURL(proxy)
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	}
	if fixture.Scheme == "https" {
		transport.TLSClientConfig.ServerName = fixture.Hostname()
	} else {
		if transport.TLSClientConfig.RootCAs == nil {
			transport.TLSClientConfig.RootCAs, _ = x509.SystemCertPool()
			if transport.TLSClientConfig.RootCAs == nil {
				transport.TLSClientConfig.RootCAs = x509.NewCertPool()
			}
		}
		transport.TLSClientConfig.RootCAs = transport.TLSClientConfig.RootCAs.Clone()
		if !transport.TLSClientConfig.RootCAs.AppendCertsFromPEM([]byte(os.Getenv("REACON_FIXTURE_CA_PEM"))) {
			panic("Fixture CA required")
		}
	}
	if transport.TLSClientConfig.InsecureSkipVerify {
		panic("Fixture TLS verification is required")
	}
	return transport
}
