package main

// The example's own fast check: the whole authorization-code + PKCE + refresh
// dance runs against the composed app in process, so a wiring mistake is caught
// by `go test` before the local-runner row replays it over real HTTP.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
	"github.com/theory-cloud/apptheory/v7/testkit"
)

const testBaseURL = "https://mcp.example.test"

func TestFacadeExampleRotationAndRefreshDance(t *testing.T) {
	cfg := exampleConfig{
		publicBaseURL:  testBaseURL,
		upstreamClient: "example-upstream-client",
		subject:        "person-1",
		handleTTL:      time.Hour,
		graceWindow:    time.Second,
		accessTTL:      time.Minute,
	}
	app, err := buildApp(cfg)
	if err != nil {
		t.Fatalf("build app: %v", err)
	}
	env := testkit.New()
	clientID, tokens := authorizeAndExchange(t, env, app)

	rotated := exchange(t, env, app, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {tokens["refresh_token"]},
		"client_id":     {clientID},
	})
	if rotated["access_token"] == "" || rotated["refresh_token"] == "" {
		t.Fatalf("refresh returned no credentials: %#v", rotated)
	}
	if rotated["refresh_token"] == tokens["refresh_token"] {
		t.Fatalf("refresh did not rotate the route handle")
	}

	state := stateDocument(t, env, app)
	families := state["families"].([]any)
	if len(families) != 1 {
		t.Fatalf("want one family, got %#v", families)
	}
	family := families[0].(map[string]any)
	members := family["members"].([]any)
	if len(members) != 2 {
		t.Fatalf("want a root and one successor, got %#v", members)
	}
	generations := map[float64]bool{}
	for _, raw := range members {
		member := raw.(map[string]any)
		generations[member["generation"].(float64)] = true
		if member["liveHead"].(bool) && member["generation"].(float64) != 2 {
			t.Fatalf("the live head is not generation 2: %#v", member)
		}
	}
	if !generations[1] || !generations[2] {
		t.Fatalf("want generations 1 and 2, got %#v", generations)
	}
	if family["revoked"].(bool) {
		t.Fatalf("the family was revoked by an ordinary refresh: %#v", family)
	}

	// The rotated access token is accepted by the resource for the lifetime the
	// token response stated: a credential the facade hands out is usable.
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example-test","version":"1"}}}`
	response := invoke(t, env, app, "POST", testBaseURL+"/acme/mcp", map[string]string{
		"accept":        "application/json, text/event-stream",
		"content-type":  "application/json",
		"authorization": "Bearer " + rotated["access_token"],
	}, []byte(initialize))
	if response.StatusCode != 200 {
		t.Fatalf("the resource refused a credential the facade issued: %d %s", response.StatusCode, response.Body)
	}
}

func TestFacadeExampleStalePredecessorIsServed(t *testing.T) {
	cfg := exampleConfig{
		publicBaseURL:  testBaseURL,
		upstreamClient: "example-upstream-client",
		subject:        "person-1",
		handleTTL:      time.Hour,
		graceWindow:    50 * time.Millisecond,
		accessTTL:      time.Minute,
	}
	app, err := buildApp(cfg)
	if err != nil {
		t.Fatalf("build app: %v", err)
	}
	env := testkit.New()
	clientID, tokens := authorizeAndExchange(t, env, app)
	time.Sleep(100 * time.Millisecond)
	served := exchange(t, env, app, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {tokens["refresh_token"]},
		"client_id":     {clientID},
	})
	if served["access_token"] == "" {
		t.Fatalf("the stale predecessor was not served: %#v", served)
	}
	state := stateDocument(t, env, app)
	family := state["families"].([]any)[0].(map[string]any)
	if family["revoked"].(bool) {
		t.Fatalf("the stale predecessor revoked the family: %#v", family)
	}
}

// authorizeAndExchange registers a client, runs the real authorize → upstream
// authorize → facade callback chain, and exchanges the code. It returns the
// client id and the first token set.
func authorizeAndExchange(t *testing.T, env *testkit.Env, app *apptheory.App) (string, map[string]string) {
	t.Helper()
	clientID, redirectURI := registerClient(t, env, app)
	verifier := "example-pkce-verifier-0123456789-0123456789"
	authorizeURL := testBaseURL + "/.well-known/oauth-authorization-server/acme/mcp/authorize?" +
		url.Values{
			"response_type":         {"code"},
			"client_id":             {clientID},
			"redirect_uri":          {redirectURI},
			"state":                 {"client-state"},
			"code_challenge":        {pkceChallenge(verifier)},
			"code_challenge_method": {"S256"},
			"scope":                 {exampleScope},
			"resource":              {testBaseURL + "/acme/mcp"},
		}.Encode()

	upstreamLocation := redirectTarget(t, env, app, "GET", authorizeURL)
	if !strings.Contains(upstreamLocation, "/_upstream/authorize") {
		t.Fatalf("authorize did not send the browser upstream: %s", upstreamLocation)
	}
	callbackLocation := redirectTarget(t, env, app, "GET", upstreamLocation)
	clientLocation := redirectTarget(t, env, app, "GET", callbackLocation)
	parsed, err := url.Parse(clientLocation)
	if err != nil {
		t.Fatalf("client redirect: %v", err)
	}
	code := parsed.Query().Get("code")
	if code == "" || parsed.Query().Get("state") != "client-state" {
		t.Fatalf("client redirect is missing code/state: %s", clientLocation)
	}
	tokens := exchange(t, env, app, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {clientID},
		"code_verifier": {verifier},
	})
	if tokens["refresh_token"] == "" || tokens["access_token"] == "" {
		t.Fatalf("code exchange returned no credentials: %#v", tokens)
	}
	return clientID, tokens
}

func registerClient(t *testing.T, env *testkit.Env, app *apptheory.App) (string, string) {
	t.Helper()
	redirectURI := "http://127.0.0.1:9999/callback"
	body, err := json.Marshal(map[string]any{
		"client_name":                "example-test-client",
		"redirect_uris":              []string{redirectURI},
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
	})
	if err != nil {
		t.Fatalf("registration body: %v", err)
	}
	response := invoke(t, env, app, "POST", testBaseURL+"/.well-known/oauth-authorization-server/acme/mcp/register",
		map[string]string{"content-type": "application/json"}, body)
	if response.StatusCode != 201 && response.StatusCode != 200 {
		t.Fatalf("registration: %d %s", response.StatusCode, response.Body)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(response.Body), &document); err != nil {
		t.Fatalf("registration body: %v", err)
	}
	clientID, _ := document["client_id"].(string)
	if clientID == "" {
		t.Fatalf("registration returned no client_id: %#v", document)
	}
	return clientID, redirectURI
}

func exchange(t *testing.T, env *testkit.Env, app *apptheory.App, form url.Values) map[string]string {
	t.Helper()
	response := invoke(t, env, app, "POST", testBaseURL+"/.well-known/oauth-authorization-server/acme/mcp/token",
		map[string]string{"content-type": "application/x-www-form-urlencoded"}, []byte(form.Encode()))
	if response.StatusCode != 200 {
		t.Fatalf("token endpoint: %d %s", response.StatusCode, response.Body)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(response.Body), &document); err != nil {
		t.Fatalf("token body: %v", err)
	}
	tokens := map[string]string{}
	for _, key := range []string{"access_token", "refresh_token", "token_type"} {
		if value, ok := document[key].(string); ok {
			tokens[key] = value
		}
	}
	return tokens
}

func stateDocument(t *testing.T, env *testkit.Env, app *apptheory.App) map[string]any {
	t.Helper()
	response := invoke(t, env, app, "GET", testBaseURL+"/_state", nil, nil)
	if response.StatusCode != 200 {
		t.Fatalf("state: %d %s", response.StatusCode, response.Body)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(response.Body), &document); err != nil {
		t.Fatalf("state body: %v", err)
	}
	return document
}

func redirectTarget(t *testing.T, env *testkit.Env, app *apptheory.App, method, target string) string {
	t.Helper()
	response := invoke(t, env, app, method, target, nil, nil)
	if response.StatusCode != 302 && response.StatusCode != 303 && response.StatusCode != 307 {
		t.Fatalf("%s %s: want a redirect, got %d %s", method, target, response.StatusCode, response.Body)
	}
	location := response.Headers["location"]
	if location == "" {
		t.Fatalf("%s %s: redirect without a Location header", method, target)
	}
	return location
}

func invoke(
	t *testing.T,
	env *testkit.Env,
	app *apptheory.App,
	method, target string,
	headers map[string]string,
	body []byte,
) events.APIGatewayV2HTTPResponse {
	t.Helper()
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatalf("parse %s: %v", target, err)
	}
	path := parsed.Path
	if parsed.RawQuery != "" {
		path += "?" + parsed.RawQuery
	}
	event := testkit.APIGatewayV2Request(method, path, testkit.HTTPEventOptions{
		Headers: headers,
		Body:    body,
	})
	return env.InvokeAPIGatewayV2(context.Background(), app, event)
}

func pkceChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
