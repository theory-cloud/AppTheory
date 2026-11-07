package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
)

// The Go caller proves that a function container's own TLS stack verifies the
// runner's certificate. The Lambda image reads SSL_CERT_FILE (the run's trust
// bundle) through crypto/x509, and this handler uses the default transport, so
// no code in this file knows about the CA.
// https://pkg.go.dev/crypto/x509#SystemCertPool

type request struct {
	URL string `json:"url"`
}

type result struct {
	OK     bool   `json:"ok"`
	Issuer string `json:"issuer"`
	Keys   int    `json:"keys"`
}

func getJSON(client *http.Client, url string, target any) error {
	response, err := client.Get(url) //nolint:gosec // the caller passes the app's own local URL
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", url, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read %s: %w", url, err)
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode %s: %w", url, err)
	}
	return nil
}

func handler(_ context.Context, event request) (result, error) {
	if event.URL == "" {
		return result{}, fmt.Errorf("url is required")
	}
	client := &http.Client{Timeout: 10 * time.Second}
	var discovery struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := getJSON(client, event.URL+"/.well-known/openid-configuration", &discovery); err != nil {
		return result{}, err
	}
	if discovery.Issuer != event.URL {
		return result{}, fmt.Errorf("issuer %q does not equal %q", discovery.Issuer, event.URL)
	}
	var jwks struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := getJSON(client, discovery.JWKSURI, &jwks); err != nil {
		return result{}, err
	}
	if len(jwks.Keys) == 0 {
		return result{}, fmt.Errorf("jwks has no keys")
	}
	return result{OK: true, Issuer: discovery.Issuer, Keys: len(jwks.Keys)}, nil
}

func main() {
	lambda.Start(handler)
}
