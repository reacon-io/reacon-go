//go:build go1.24

// Copyright Reacon contributors. Licensed under Apache-2.0.
package reacon

import "net/http"

func configureHTTP1Protocols(transport *http.Transport) {
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
}
