// Package oauth provides a small test harness for OAuth flows used by Claude
// Remote MCP connectors (DCR + PKCE + refresh).
package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	oauthruntime "github.com/theory-cloud/apptheory/runtime/oauth"
)

// ClaudePublicClient is an OAuth test client that emulates Claude connector behavior.
type ClaudePublicClient struct {
	http *http.Client
}

// NewClaudePublicClient creates a client. If httpClient is nil, a default client
// is created that does not automatically follow redirects (required to capture
// authorization codes from Location headers).
func NewClaudePublicClient(httpClient *http.Client) *ClaudePublicClient {
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &ClaudePublicClient{http: httpClient}
}

type AuthorizeOptions struct {
	// McpEndpoint is the protected MCP resource URL (the `/mcp` endpoint).
	McpEndpoint string
	// Origin is passed as the Origin header on the first MCP call.
	// Defaults to https://claude.ai.
	Origin string
	// RedirectURI must match the authorization server policy allowlist.
	RedirectURI string
}

type Discovery struct {
	ResourceMetadataURL         string
	ProtectedResourceMetadata   *oauthruntime.ProtectedResourceMetadata
	AuthorizationServerMetadata *oauthruntime.AuthorizationServerMetadata
}

type DCRResult struct {
	ClientID string
}

type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in,omitempty"`
}

func readBodyAndClose(resp *http.Response, limit int64) ([]byte, error) {
	if resp == nil || resp.Body == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 4096
	}

	b, readErr := io.ReadAll(io.LimitReader(resp.Body, limit))
	closeErr := resp.Body.Close()

	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return b, nil
}

// Authorize performs:
// - 401 challenge parsing (WWW-Authenticate)
// - protected resource metadata fetch
// - AS metadata fetch
// - DCR
// - Authorization Code + PKCE
// - Token exchange + refresh
func (c *ClaudePublicClient) Authorize(ctx context.Context, opts AuthorizeOptions) (*Discovery, *DCRResult, *TokenResponse, *TokenResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	mcpEndpoint := strings.TrimRight(strings.TrimSpace(opts.McpEndpoint), "/")
	if mcpEndpoint == "" {
		return nil, nil, nil, nil, fmt.Errorf("oauth: McpEndpoint is required")
	}

	origin := strings.TrimSpace(opts.Origin)
	if origin == "" {
		origin = "https://claude.ai"
	}
	redirectURI := strings.TrimSpace(opts.RedirectURI)
	if redirectURI == "" {
		redirectURI = "https://claude.ai/api/mcp/auth_callback"
	}

	discovery, err := c.discover(ctx, mcpEndpoint, origin)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	dcr, err := c.register(ctx, discovery.AuthorizationServerMetadata.RegistrationEndpoint, redirectURI)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	verifier, err := oauthruntime.NewPKCECodeVerifier()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	challenge, err := oauthruntime.PKCEChallengeS256(verifier)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	code, err := c.authorizeCode(ctx, discovery.AuthorizationServerMetadata.AuthorizationEndpoint, authorizeCodeRequest{
		ClientID:            dcr.ClientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       challenge,
		CodeChallengeMethod: "S256",
		Resource:            discovery.ProtectedResourceMetadata.Resource,
	})
	if err != nil {
		return nil, nil, nil, nil, err
	}

	tokenResp, err := c.exchangeCode(ctx, discovery.AuthorizationServerMetadata.TokenEndpoint, tokenCodeExchange{
		ClientID:     dcr.ClientID,
		RedirectURI:  redirectURI,
		Code:         code,
		CodeVerifier: verifier,
		Resource:     discovery.ProtectedResourceMetadata.Resource,
	})
	if err != nil {
		return nil, nil, nil, nil, err
	}

	refreshResp, err := c.refresh(ctx, discovery.AuthorizationServerMetadata.TokenEndpoint, tokenRefreshRequest{
		ClientID:     dcr.ClientID,
		RefreshToken: tokenResp.RefreshToken,
		Resource:     discovery.ProtectedResourceMetadata.Resource,
	})
	if err != nil {
		return nil, nil, nil, nil, err
	}

	return discovery, dcr, tokenResp, refreshResp, nil
}

func (c *ClaudePublicClient) discover(ctx context.Context, mcpEndpoint, origin string) (*Discovery, error) {
	// A) Call MCP without a token to get the RFC9728 discovery challenge.
	initializeBody := []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Claude","version":"unknown"}}}`)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, mcpEndpoint, bytes.NewReader(initializeBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	body, err := readBodyAndClose(resp, 4096)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 401 {
		return nil, fmt.Errorf("oauth: expected 401 from MCP (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	resourceMetadataURL, ok := resourceMetadataFromWWWAuthenticate(resp.Header.Values("WWW-Authenticate"))
	if !ok {
		return nil, fmt.Errorf("oauth: 401 missing WWW-Authenticate resource_metadata")
	}

	pr, err := c.fetchProtectedResourceMetadata(ctx, resourceMetadataURL)
	if err != nil {
		return nil, err
	}
	if len(pr.AuthorizationServers) == 0 {
		return nil, fmt.Errorf("oauth: protected resource metadata missing authorization_servers")
	}

	asMeta, err := c.fetchAuthorizationServerMetadata(ctx, pr.AuthorizationServers[0])
	if err != nil {
		return nil, err
	}

	return &Discovery{
		ResourceMetadataURL:         resourceMetadataURL,
		ProtectedResourceMetadata:   pr,
		AuthorizationServerMetadata: asMeta,
	}, nil
}

func (c *ClaudePublicClient) fetchProtectedResourceMetadata(ctx context.Context, resourceMetadataURL string) (*oauthruntime.ProtectedResourceMetadata, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resourceMetadataURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	body, err := readBodyAndClose(resp, 1<<20)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("oauth: protected resource metadata: expected 200 (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var md oauthruntime.ProtectedResourceMetadata
	if err := json.Unmarshal(body, &md); err != nil {
		return nil, fmt.Errorf("oauth: protected resource metadata decode: %w", err)
	}
	return &md, nil
}

func (c *ClaudePublicClient) fetchAuthorizationServerMetadata(ctx context.Context, issuer string) (*oauthruntime.AuthorizationServerMetadata, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	if issuer == "" {
		return nil, errors.New("oauth: issuer required")
	}

	u, err := url.Parse(issuer)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("oauth: invalid issuer: %s", issuer)
	}

	// RFC8414: for issuers with path components, the metadata is typically hosted
	// under that path.
	u.Path = strings.TrimRight(u.Path, "/") + "/.well-known/oauth-authorization-server"
	u.RawQuery = ""
	u.Fragment = ""

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	body, err := readBodyAndClose(resp, 1<<20)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("oauth: as metadata: expected 200 (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var md oauthruntime.AuthorizationServerMetadata
	if err := json.Unmarshal(body, &md); err != nil {
		return nil, fmt.Errorf("oauth: as metadata decode: %w", err)
	}
	return &md, nil
}

func (c *ClaudePublicClient) register(ctx context.Context, registrationEndpoint, redirectURI string) (*DCRResult, error) {
	reqBody, err := json.Marshal(map[string]any{
		"client_name":                "Claude",
		"redirect_uris":              []string{redirectURI},
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, registrationEndpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	respBody, err := readBodyAndClose(resp, 1<<20)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return nil, fmt.Errorf("oauth: dcr: expected 200/201 (got %d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("oauth: dcr decode: %w", err)
	}
	if out.ClientID == "" {
		return nil, fmt.Errorf("oauth: dcr missing client_id")
	}
	return &DCRResult{ClientID: out.ClientID}, nil
}

type authorizeCodeRequest struct {
	ClientID            string
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Resource            string
}

func (c *ClaudePublicClient) authorizeCode(ctx context.Context, authorizationEndpoint string, req authorizeCodeRequest) (string, error) {
	u, err := url.Parse(authorizationEndpoint)
	if err != nil {
		return "", err
	}

	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", req.ClientID)
	q.Set("redirect_uri", req.RedirectURI)
	q.Set("code_challenge", req.CodeChallenge)
	q.Set("code_challenge_method", req.CodeChallengeMethod)
	if req.Resource != "" {
		q.Set("resource", req.Resource)
	}
	u.RawQuery = q.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return "", err
	}
	body, err := readBodyAndClose(resp, 4096)
	if err != nil {
		return "", err
	}

	if resp.StatusCode != 302 && resp.StatusCode != 303 {
		return "", fmt.Errorf("oauth: authorize: expected redirect (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	loc := strings.TrimSpace(resp.Header.Get("Location"))
	if loc == "" {
		return "", fmt.Errorf("oauth: authorize: missing Location header")
	}
	ru, err := url.Parse(loc)
	if err != nil {
		return "", fmt.Errorf("oauth: authorize: invalid Location: %w", err)
	}
	code := ru.Query().Get("code")
	if code == "" {
		return "", fmt.Errorf("oauth: authorize: missing code in redirect")
	}
	return code, nil
}

type tokenCodeExchange struct {
	ClientID     string
	RedirectURI  string
	Code         string
	CodeVerifier string
	Resource     string
}

func (c *ClaudePublicClient) exchangeCode(ctx context.Context, tokenEndpoint string, req tokenCodeExchange) (*TokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", req.ClientID)
	form.Set("redirect_uri", req.RedirectURI)
	form.Set("code", req.Code)
	form.Set("code_verifier", req.CodeVerifier)
	if req.Resource != "" {
		form.Set("resource", req.Resource)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	body, err := readBodyAndClose(resp, 1<<20)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("oauth: token exchange: expected 200 (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out TokenResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("oauth: token exchange decode: %w", err)
	}
	if out.AccessToken == "" || out.TokenType == "" {
		return nil, fmt.Errorf("oauth: token exchange missing fields")
	}
	return &out, nil
}

type tokenRefreshRequest struct {
	ClientID     string
	RefreshToken string
	Resource     string
}

func (c *ClaudePublicClient) refresh(ctx context.Context, tokenEndpoint string, req tokenRefreshRequest) (*TokenResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", req.ClientID)
	form.Set("refresh_token", req.RefreshToken)
	if req.Resource != "" {
		form.Set("resource", req.Resource)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	body, err := readBodyAndClose(resp, 1<<20)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("oauth: refresh: expected 200 (got %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out TokenResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("oauth: refresh decode: %w", err)
	}
	if out.AccessToken == "" || out.TokenType == "" {
		return nil, fmt.Errorf("oauth: refresh missing fields")
	}
	return &out, nil
}

func resourceMetadataFromWWWAuthenticate(values []string) (string, bool) {
	for _, v := range values {
		if u, ok := parseResourceMetadataParam(v); ok {
			return u, true
		}
	}
	return "", false
}

func parseResourceMetadataParam(headerValue string) (string, bool) {
	// Minimal parser for:
	//   Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"
	// We intentionally avoid full RFC parsing; we only need resource_metadata.
	headerValue = strings.TrimSpace(headerValue)
	if headerValue == "" {
		return "", false
	}
	if !strings.HasPrefix(strings.ToLower(headerValue), "bearer") {
		return "", false
	}
	lower := strings.ToLower(headerValue)
	i := strings.Index(lower, "resource_metadata=")
	if i < 0 {
		return "", false
	}
	rest := strings.TrimSpace(headerValue[i+len("resource_metadata="):])
	if rest == "" {
		return "", false
	}
	if rest[0] == '"' {
		rest = rest[1:]
		j := strings.Index(rest, "\"")
		if j < 0 {
			return "", false
		}
		return rest[:j], true
	}
	// Unquoted: read until comma/space.
	for k, ch := range rest {
		if ch == ',' || ch == ' ' || ch == '\t' {
			rest = rest[:k]
			break
		}
	}
	rest = strings.TrimSpace(rest)
	return rest, rest != ""
}
