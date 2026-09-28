//go:build !go1.24

// Copyright Reacon contributors. Licensed under Apache-2.0.
package reacon

import "net/http"

// Go 1.23 uses ForceAttemptHTTP2 and TLSNextProto, configured by the caller.
func configureHTTP1Protocols(transport *http.Transport) {}
