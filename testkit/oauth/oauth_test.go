package oauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	oauthruntime "github.com/theory-cloud/apptheory/runtime/oauth"
)

func mustWrite(w http.ResponseWriter, b []byte) {
	if _, err := w.Write(b); err != nil {
		panic(err)
	}
}

func TestClaudePublicClient_DCR_PKCE_Refresh(t *testing.T) {
	ctx := context.Background()

	// ---- Authorization Server stub (Autheory-like) ----
	var nextClientID int64 = 100
	codeStore := oauthruntime.NewMemoryAuthorizationCodeStore()
	refreshStore := oauthruntime.NewMemoryRefreshTokenStore()

	var authBase string
	authMux := http.NewServeMux()

	authMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		md, err := oauthruntime.NewAuthorizationServerMetadata(authBase)
		require.NoError(t, err)
		b, err := md.MarshalJSONBytes()
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, b)
	})

	authMux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		var req oauthruntime.DynamicClientRegistrationRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		require.NoError(t, oauthruntime.ValidateDynamicClientRegistrationRequest(&req, oauthruntime.ClaudeDynamicClientRegistrationPolicy()))

		id := atomic.AddInt64(&nextClientID, 1)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, []byte(`{"client_id":"claude-client-`+strconv.FormatInt(id, 10)+`"}`))
	})

	authMux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		require.Equal(t, "code", q.Get("response_type"))
		require.NotEmpty(t, q.Get("client_id"))
		require.NotEmpty(t, q.Get("redirect_uri"))
		require.NotEmpty(t, q.Get("code_challenge"))
		require.Equal(t, "S256", q.Get("code_challenge_method"))
		require.NotEmpty(t, q.Get("resource"))

		code, err := oauthruntime.NewOpaqueToken()
		require.NoError(t, err)
		require.NoError(t, codeStore.Put(ctx, &oauthruntime.AuthorizationCodeRecord{
			Code:                code,
			ClientID:            q.Get("client_id"),
			RedirectURI:         q.Get("redirect_uri"),
			Resource:            q.Get("resource"),
			CodeChallenge:       q.Get("code_challenge"),
			CodeChallengeMethod: q.Get("code_challenge_method"),
			ExpiresAt:           time.Now().Add(2 * time.Minute).UTC(),
		}))

		ru, err := url.Parse(q.Get("redirect_uri"))
		require.NoError(t, err)
		qq := ru.Query()
		qq.Set("code", code)
		ru.RawQuery = qq.Encode()
		http.Redirect(w, r, ru.String(), http.StatusFound)
	})

	authMux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		grantType := r.Form.Get("grant_type")
		resource := r.Form.Get("resource")
		require.NotEmpty(t, resource)

		switch grantType {
		case "authorization_code":
			code := r.Form.Get("code")
			verifier := r.Form.Get("code_verifier")
			clientID := r.Form.Get("client_id")
			redirectURI := r.Form.Get("redirect_uri")
			require.NotEmpty(t, code)
			require.NotEmpty(t, verifier)
			require.NotEmpty(t, clientID)
			require.NotEmpty(t, redirectURI)

			rec, err := codeStore.Consume(ctx, code)
			require.NoError(t, err)
			require.Equal(t, clientID, rec.ClientID)
			require.Equal(t, redirectURI, rec.RedirectURI)
			require.Equal(t, resource, rec.Resource)

			ok, err := oauthruntime.PKCEVerifyS256(verifier, rec.CodeChallenge)
			require.NoError(t, err)
			require.True(t, ok)

			access, err := oauthruntime.NewOpaqueToken()
			require.NoError(t, err)
			refresh, err := oauthruntime.NewOpaqueToken()
			require.NoError(t, err)
			require.NoError(t, refreshStore.Put(ctx, &oauthruntime.RefreshTokenRecord{
				Token:     refresh,
				ClientID:  clientID,
				Subject:   "user-1",
				Resource:  resource,
				ExpiresAt: time.Now().Add(24 * time.Hour).UTC(),
			}))

			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			mustWrite(w, []byte(`{"access_token":"`+access+`","refresh_token":"`+refresh+`","token_type":"Bearer","expires_in":3600}`))
		case "refresh_token":
			refresh := r.Form.Get("refresh_token")
			clientID := r.Form.Get("client_id")
			require.NotEmpty(t, refresh)
			require.NotEmpty(t, clientID)

			rec, err := refreshStore.Consume(ctx, refresh)
			require.NoError(t, err)
			require.Equal(t, clientID, rec.ClientID)
			require.Equal(t, resource, rec.Resource)

			access, err := oauthruntime.NewOpaqueToken()
			require.NoError(t, err)
			newRefresh, err := oauthruntime.NewOpaqueToken()
			require.NoError(t, err)
			require.NoError(t, refreshStore.Put(ctx, &oauthruntime.RefreshTokenRecord{
				Token:     newRefresh,
				ClientID:  clientID,
				Subject:   rec.Subject,
				Resource:  rec.Resource,
				ExpiresAt: time.Now().Add(24 * time.Hour).UTC(),
			}))

			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			mustWrite(w, []byte(`{"access_token":"`+access+`","refresh_token":"`+newRefresh+`","token_type":"Bearer","expires_in":3600}`))
		default:
			http.Error(w, "unsupported grant_type", http.StatusBadRequest)
		}
	})

	authServer := httptest.NewServer(authMux)
	defer authServer.Close()
	authBase = authServer.URL

	// ---- MCP Resource Server stub ----
	var mcpBase string
	mcpMux := http.NewServeMux()

	mcpMux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, _ *http.Request) {
		md, err := oauthruntime.NewProtectedResourceMetadata(mcpBase+"/mcp", []string{authBase})
		require.NoError(t, err)
		b, err := md.MarshalJSONBytes()
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, b)
	})

	mcpMux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if strings.TrimSpace(authz) == "" {
			w.Header().Set("WWW-Authenticate", oauthruntime.ProtectedResourceWWWAuthenticate(mcpBase+"/.well-known/oauth-protected-resource"))
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, []byte(`{"ok":true}`))
	})

	mcpServer := httptest.NewServer(mcpMux)
	defer mcpServer.Close()
	mcpBase = mcpServer.URL

	// ---- Run Claude-like flow ----
	client := NewClaudePublicClient(nil)
	discovery, dcr, tokens, refreshed, err := client.Authorize(ctx, AuthorizeOptions{
		McpEndpoint: mcpBase + "/mcp",
		Origin:      "https://claude.ai",
		RedirectURI: "https://claude.ai/api/mcp/auth_callback",
	})
	require.NoError(t, err)

	require.Equal(t, mcpBase+"/.well-known/oauth-protected-resource", discovery.ResourceMetadataURL)
	require.Equal(t, mcpBase+"/mcp", discovery.ProtectedResourceMetadata.Resource)
	require.Equal(t, authBase, discovery.ProtectedResourceMetadata.AuthorizationServers[0])
	require.NotEmpty(t, dcr.ClientID)
	require.NotEmpty(t, tokens.AccessToken)
	require.NotEmpty(t, tokens.RefreshToken)
	require.Equal(t, "Bearer", tokens.TokenType)
	require.NotEmpty(t, refreshed.AccessToken)
	require.NotEmpty(t, refreshed.RefreshToken)
	require.Equal(t, "Bearer", refreshed.TokenType)
}
