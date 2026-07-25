package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
	"github.com/theory-cloud/apptheory/v2/runtime/oauth"
)

type oauthFixtureState struct {
	clients map[string]oauth.DynamicClientRegistrationRequest
	codes   map[string]oauthFixtureAuthCode
	ids     *oauthIDSequence
}

type oauthFixtureAuthCode struct {
	Code                string
	ClientID            string
	RedirectURI         string
	Resource            string
	Scope               string
	CodeChallenge       string
	CodeChallengeMethod string
}

type oauthIDSequence struct {
	values []string
	next   int
}

func (s *oauthIDSequence) nextID(prefix string) string {
	if s != nil && s.next < len(s.values) {
		out := strings.TrimSpace(s.values[s.next])
		s.next++
		if out != "" {
			return out
		}
	}
	if s == nil {
		return prefix + "_1"
	}
	s.next++
	return fmt.Sprintf("%s_%d", prefix, s.next)
}

func runFixtureOAuth(f Fixture) error {
	app, err := newOAuthFixtureApp(f.Setup.OAuth)
	if err != nil {
		return err
	}
	if f.Input.OAuth == nil || f.Expect.OAuth == nil {
		return fmt.Errorf("oauth fixture missing input.oauth or expect.oauth")
	}
	steps := f.Input.OAuth.Steps
	expected := f.Expect.OAuth.Steps
	if len(steps) != len(expected) {
		return fmt.Errorf("oauth steps length mismatch: expected %d, got %d", len(expected), len(steps))
	}
	for i, step := range steps {
		req, err := canonicalizeRequest(step.Request)
		if err != nil {
			return fmt.Errorf("step %s canonicalize request: %w", step.Name, err)
		}
		actual := app.Serve(context.Background(), apptheory.Request{
			Method:   req.Method,
			Path:     req.Path,
			Query:    req.Query,
			Headers:  req.Headers,
			Body:     req.Body,
			IsBase64: req.IsBase64,
		})
		if err := compareOAuthStep(expected[i], actual); err != nil {
			return fmt.Errorf("step %s: %w", step.Name, err)
		}
	}
	return nil
}

func newOAuthFixtureApp(setup FixtureOAuthSetup) (*apptheory.App, error) {
	resource := strings.TrimSpace(setup.Resource)
	if resource == "" {
		return nil, fmt.Errorf("oauth setup missing resource")
	}
	metadataURL, ok := oauth.ResourceMetadataURLFromMcpEndpoint(resource)
	if !ok {
		return nil, fmt.Errorf("oauth setup resource is not an absolute URL")
	}
	metadataPath, err := urlPath(metadataURL)
	if err != nil {
		return nil, err
	}
	clock := time.Unix(setup.ClockUnix, 0).UTC()
	state := &oauthFixtureState{
		clients: map[string]oauth.DynamicClientRegistrationRequest{},
		codes:   map[string]oauthFixtureAuthCode{},
		ids:     &oauthIDSequence{values: append([]string(nil), setup.IDSequence...)},
	}
	app := apptheory.New(apptheory.WithTier(apptheory.TierP0))

	md, err := oauth.NewProtectedResourceMetadata(resource, setup.AuthorizationServers)
	if err != nil {
		return nil, err
	}
	md.ScopesSupported = append([]string(nil), setup.ScopesSupported...)
	md.BearerMethodsSupported = []string{"header"}
	app.Get(metadataPath, oauth.ProtectedResourceMetadataHandler(md))

	validator := oauth.NewMemoryBearerTokenValidator(oauthTokenRecords(setup.BearerTokens), oauth.BearerTokenValidationOptions{
		RequiredAudience: strings.TrimSpace(firstNonEmpty(setup.RequiredAudience, resource)),
		RequiredScopes:   append([]string(nil), setup.RequiredScopes...),
		Now:              func() time.Time { return clock },
	})
	protected := oauth.RequireBearerTokenMiddleware(oauth.RequireBearerTokenOptions{
		ResourceMetadataURL: metadataURL,
		ClaimsValidator:     validator,
	})(func(c *apptheory.Context) (*apptheory.Response, error) {
		claims, _ := oauth.BearerTokenClaimsFromContext(c)
		return apptheory.JSON(200, map[string]any{
			"ok":      true,
			"subject": claims.Subject,
			"scopes":  claims.Scopes,
		})
	})
	app.Get(resourcePath(resource), protected)

	policy := oauth.DynamicClientRegistrationPolicy{
		AllowedRedirectURIs: append([]string(nil), setup.DCRPolicy.AllowedRedirectURIs...),
		RequirePublicClient: setup.DCRPolicy.RequirePublicClient,
		RequireRefreshToken: setup.DCRPolicy.RequireRefreshToken,
	}
	app.Post("/register", oauthDCRHandler(state, policy, clock))
	app.Get("/authorize", oauthAuthorizeHandler(state, resource))
	app.Post("/token", oauthTokenHandler(state, resource))
	return app, nil
}

func oauthTokenRecords(in []FixtureOAuthToken) []oauth.BearerTokenRecord {
	out := make([]oauth.BearerTokenRecord, 0, len(in))
	for _, rec := range in {
		var expires time.Time
		if rec.ExpiresUnix != 0 {
			expires = time.Unix(rec.ExpiresUnix, 0).UTC()
		}
		out = append(out, oauth.BearerTokenRecord{
			Token:     rec.Token,
			Subject:   rec.Subject,
			Audience:  rec.Audience,
			Scope:     rec.Scope,
			Scopes:    append([]string(nil), rec.Scopes...),
			ExpiresAt: expires,
		})
	}
	return out
}

func oauthDCRHandler(state *oauthFixtureState, policy oauth.DynamicClientRegistrationPolicy, clock time.Time) apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		var req oauth.DynamicClientRegistrationRequest
		if err := json.Unmarshal(c.Request.Body, &req); err != nil {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		if err := oauth.ValidateDynamicClientRegistrationRequest(&req, policy); err != nil {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		clientID := state.ids.nextID("client")
		state.clients[clientID] = req
		return apptheory.JSON(201, oauth.DynamicClientRegistrationResponse{
			ClientID:         clientID,
			ClientIDIssuedAt: clock.Unix(),
		})
	}
}

func oauthAuthorizeHandler(state *oauthFixtureState, resource string) apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		q := c.Request.Query
		clientID := firstQuery(q, "client_id")
		client, ok := state.clients[clientID]
		if !ok || firstQuery(q, "response_type") != "code" || firstQuery(q, "code_challenge_method") != "S256" || firstQuery(q, "resource") != resource {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		redirectURI := firstQuery(q, "redirect_uri")
		if !stringInSlice(redirectURI, client.RedirectURIs) {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		challenge := strings.TrimSpace(firstQuery(q, "code_challenge"))
		if challenge == "" {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		code := state.ids.nextID("code")
		state.codes[code] = oauthFixtureAuthCode{
			Code:                code,
			ClientID:            clientID,
			RedirectURI:         redirectURI,
			Resource:            resource,
			Scope:               firstQuery(q, "scope"),
			CodeChallenge:       challenge,
			CodeChallengeMethod: "S256",
		}
		location, err := redirectWithCode(redirectURI, code, firstQuery(q, "state"))
		if err != nil {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		return &apptheory.Response{Status: 302, Headers: map[string][]string{"location": {location}}}, nil
	}
}

func oauthTokenHandler(state *oauthFixtureState, resource string) apptheory.Handler {
	return func(c *apptheory.Context) (*apptheory.Response, error) {
		values, err := url.ParseQuery(string(c.Request.Body))
		if err != nil || values.Get("grant_type") != "authorization_code" || values.Get("resource") != resource {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		code := values.Get("code")
		rec, ok := state.codes[code]
		if !ok {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		delete(state.codes, code)
		if values.Get("client_id") != rec.ClientID || values.Get("redirect_uri") != rec.RedirectURI {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		valid, err := oauth.PKCEVerifyS256(values.Get("code_verifier"), rec.CodeChallenge)
		if err != nil || !valid {
			return oauthErrorResponse(400, "app.bad_request", "bad request"), nil
		}
		access := state.ids.nextID("access")
		refresh := state.ids.nextID("refresh")
		return apptheory.JSON(200, map[string]any{
			"access_token":  access,
			"refresh_token": refresh,
			"token_type":    "Bearer",
			"expires_in":    3600,
			"scope":         rec.Scope,
		})
	}
}

func compareOAuthStep(expected FixtureOAuthExpectedStep, actual apptheory.Response) error {
	actual.Headers = canonicalizeHeaders(actual.Headers)
	expectedHeaders := canonicalizeHeaders(expected.Headers)
	if expected.Status != actual.Status {
		return fmt.Errorf("status: expected %d, got %d", expected.Status, actual.Status)
	}
	if expected.IsBase64 != actual.IsBase64 {
		return fmt.Errorf("is_base64: expected %v, got %v", expected.IsBase64, actual.IsBase64)
	}
	if !equalStringSlices(expected.Cookies, actual.Cookies) {
		return fmt.Errorf("cookies mismatch")
	}
	if !equalHeaders(expectedHeaders, actual.Headers) {
		return fmt.Errorf("headers mismatch")
	}
	if len(expected.BodyJSON) > 0 {
		var expectedJSON any
		if err := json.Unmarshal(expected.BodyJSON, &expectedJSON); err != nil {
			return fmt.Errorf("parse expected body_json: %w", err)
		}
		var actualJSON any
		if err := json.Unmarshal(actual.Body, &actualJSON); err != nil {
			return fmt.Errorf("parse actual response body as json: %w", err)
		}
		if !jsonEqual(expectedJSON, actualJSON) {
			return fmt.Errorf("body_json mismatch")
		}
		return nil
	}
	var expectedBody []byte
	if expected.Body != nil {
		body, err := decodeFixtureBody(*expected.Body)
		if err != nil {
			return err
		}
		expectedBody = body
	}
	if !equalBytes(expectedBody, actual.Body) {
		return fmt.Errorf("body mismatch")
	}
	return nil
}

func oauthErrorResponse(status int, code, message string) *apptheory.Response {
	return &apptheory.Response{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"application/json; charset=utf-8"},
		},
		Body: []byte(fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, code, message)),
	}
}

func firstQuery(values map[string][]string, name string) string {
	items := values[name]
	if len(items) == 0 {
		return ""
	}
	return strings.TrimSpace(items[0])
}

func stringInSlice(value string, items []string) bool {
	for _, item := range items {
		if strings.TrimSpace(item) == value {
			return true
		}
	}
	return false
}

func redirectWithCode(redirectURI, code, state string) (string, error) {
	u, err := url.Parse(redirectURI)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid redirect uri")
	}
	q := u.Query()
	q.Set("code", code)
	if strings.TrimSpace(state) != "" {
		q.Set("state", strings.TrimSpace(state))
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func urlPath(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid url: %s", raw)
	}
	if u.Path == "" {
		return "/", nil
	}
	return u.Path, nil
}

func resourcePath(raw string) string {
	p, err := urlPath(raw)
	if err != nil || p == "" {
		return "/mcp"
	}
	return p
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
