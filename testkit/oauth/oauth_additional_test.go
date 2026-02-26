package oauth

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	oauthruntime "github.com/theory-cloud/apptheory/runtime/oauth"
)

type readErrCloser struct{}

func (readErrCloser) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (readErrCloser) Close() error             { return nil }

type closeErrCloser struct {
	r io.Reader
}

func (c closeErrCloser) Read(p []byte) (int, error) { return c.r.Read(p) }
func (closeErrCloser) Close() error                 { return errors.New("close failed") }

func TestReadBodyAndClose_NilAndErrorCases(t *testing.T) {
	b, err := readBodyAndClose(nil, 0)
	require.NoError(t, err)
	require.Nil(t, b)

	b, err = readBodyAndClose(&http.Response{Body: nil}, 0)
	require.NoError(t, err)
	require.Nil(t, b)

	_, err = readBodyAndClose(&http.Response{Body: readErrCloser{}}, 0)
	require.Error(t, err)

	_, err = readBodyAndClose(&http.Response{Body: closeErrCloser{r: bytes.NewReader([]byte("ok"))}}, 0)
	require.Error(t, err)
}

func TestParseResourceMetadataParam_Variants(t *testing.T) {
	u, ok := parseResourceMetadataParam(`Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"`)
	require.True(t, ok)
	require.Equal(t, "https://example.com/.well-known/oauth-protected-resource", u)

	u, ok = parseResourceMetadataParam(`Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource`)
	require.True(t, ok)
	require.Equal(t, "https://example.com/.well-known/oauth-protected-resource", u)

	u, ok = parseResourceMetadataParam(`Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource, realm="x"`)
	require.True(t, ok)
	require.Equal(t, "https://example.com/.well-known/oauth-protected-resource", u)

	_, ok = parseResourceMetadataParam(`Basic realm="x"`)
	require.False(t, ok)

	_, ok = parseResourceMetadataParam(`Bearer`)
	require.False(t, ok)

	_, ok = parseResourceMetadataParam(`Bearer resource_metadata="unterminated`)
	require.False(t, ok)

	u, ok = resourceMetadataFromWWWAuthenticate([]string{
		`Basic realm="x"`,
		`Bearer resource_metadata="https://ok.example/.well-known/oauth-protected-resource"`,
	})
	require.True(t, ok)
	require.Equal(t, "https://ok.example/.well-known/oauth-protected-resource", u)
}

func TestDiscover_Errors(t *testing.T) {
	client := NewClaudePublicClient(nil)

	t.Run("non-401", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
			mustWrite(w, []byte(`{"ok":true}`))
		}))
		defer srv.Close()

		_, err := client.discover(context.Background(), srv.URL, "https://claude.ai")
		require.Error(t, err)
	})

	t.Run("missing-www-authenticate", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		}))
		defer srv.Close()

		_, err := client.discover(context.Background(), srv.URL, "https://claude.ai")
		require.Error(t, err)
	})

	t.Run("protected-resource-missing-authorization-servers", func(t *testing.T) {
		var base string
		mux := http.NewServeMux()
		mux.HandleFunc("/mcp", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("WWW-Authenticate", oauthruntime.ProtectedResourceWWWAuthenticate(base+"/pr"))
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		})
		mux.HandleFunc("/pr", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{"resource":"`+base+`/mcp","authorization_servers":[]}`))
		})
		srv := httptest.NewServer(mux)
		defer srv.Close()
		base = srv.URL

		_, err := client.discover(context.Background(), base+"/mcp", "https://claude.ai")
		require.Error(t, err)
	})
}

func TestFetchAuthorizationServerMetadata_RejectsInvalidIssuer(t *testing.T) {
	client := NewClaudePublicClient(nil)
	_, err := client.fetchAuthorizationServerMetadata(context.Background(), "not-a-url")
	require.Error(t, err)

	_, err = client.fetchAuthorizationServerMetadata(context.Background(), " ")
	require.Error(t, err)
}

func TestRegister_AuthorizeCode_AndTokenErrors(t *testing.T) {
	client := NewClaudePublicClient(nil)

	t.Run("register-non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"bad"}`, http.StatusBadRequest)
		}))
		defer srv.Close()

		_, err := client.register(context.Background(), srv.URL, "https://claude.ai/api/mcp/auth_callback")
		require.Error(t, err)
	})

	t.Run("register-missing-client-id", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{}`))
		}))
		defer srv.Close()

		_, err := client.register(context.Background(), srv.URL, "https://claude.ai/api/mcp/auth_callback")
		require.Error(t, err)
	})

	t.Run("authorize-non-redirect", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
			mustWrite(w, []byte("ok"))
		}))
		defer srv.Close()

		_, err := client.authorizeCode(context.Background(), srv.URL, authorizeCodeRequest{
			ClientID:            "c",
			RedirectURI:         "https://claude.ai/api/mcp/auth_callback",
			CodeChallenge:       "cc",
			CodeChallengeMethod: "S256",
		})
		require.Error(t, err)
	})

	t.Run("authorize-missing-location", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusFound)
		}))
		defer srv.Close()

		_, err := client.authorizeCode(context.Background(), srv.URL, authorizeCodeRequest{
			ClientID:            "c",
			RedirectURI:         "https://claude.ai/api/mcp/auth_callback",
			CodeChallenge:       "cc",
			CodeChallengeMethod: "S256",
		})
		require.Error(t, err)
	})

	t.Run("authorize-missing-code", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "https://claude.ai/api/mcp/auth_callback")
			w.WriteHeader(http.StatusFound)
		}))
		defer srv.Close()

		_, err := client.authorizeCode(context.Background(), srv.URL, authorizeCodeRequest{
			ClientID:            "c",
			RedirectURI:         "https://claude.ai/api/mcp/auth_callback",
			CodeChallenge:       "cc",
			CodeChallengeMethod: "S256",
		})
		require.Error(t, err)
	})

	t.Run("authorize-invalid-location", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "%%%")
			w.WriteHeader(http.StatusFound)
		}))
		defer srv.Close()

		_, err := client.authorizeCode(context.Background(), srv.URL, authorizeCodeRequest{
			ClientID:            "c",
			RedirectURI:         "https://claude.ai/api/mcp/auth_callback",
			CodeChallenge:       "cc",
			CodeChallengeMethod: "S256",
		})
		require.Error(t, err)
	})

	t.Run("token-non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"bad"}`, http.StatusBadRequest)
		}))
		defer srv.Close()

		_, err := client.exchangeCode(context.Background(), srv.URL, tokenCodeExchange{ClientID: "c", Code: "x", CodeVerifier: "v"})
		require.Error(t, err)
	})

	t.Run("token-missing-fields", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{"access_token":"","token_type":""}`))
		}))
		defer srv.Close()

		_, err := client.exchangeCode(context.Background(), srv.URL, tokenCodeExchange{ClientID: "c", Code: "x", CodeVerifier: "v"})
		require.Error(t, err)
	})

	t.Run("token-invalid-json", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{`))
		}))
		defer srv.Close()

		_, err := client.exchangeCode(context.Background(), srv.URL, tokenCodeExchange{ClientID: "c", Code: "x", CodeVerifier: "v"})
		require.Error(t, err)
	})

	t.Run("refresh-non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"bad"}`, http.StatusBadRequest)
		}))
		defer srv.Close()

		_, err := client.refresh(context.Background(), srv.URL, tokenRefreshRequest{ClientID: "c", RefreshToken: "r"})
		require.Error(t, err)
	})

	t.Run("refresh-invalid-json", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{`))
		}))
		defer srv.Close()

		_, err := client.refresh(context.Background(), srv.URL, tokenRefreshRequest{ClientID: "c", RefreshToken: "r"})
		require.Error(t, err)
	})
}

func TestFetchProtectedResourceMetadata_Errors(t *testing.T) {
	client := NewClaudePublicClient(nil)

	t.Run("non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"nope"}`, http.StatusInternalServerError)
		}))
		defer srv.Close()

		_, err := client.fetchProtectedResourceMetadata(context.Background(), srv.URL)
		require.Error(t, err)
	})

	t.Run("invalid-json", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{`))
		}))
		defer srv.Close()

		_, err := client.fetchProtectedResourceMetadata(context.Background(), srv.URL)
		require.Error(t, err)
	})
}

func TestFetchAuthorizationServerMetadata_Errors(t *testing.T) {
	client := NewClaudePublicClient(nil)

	t.Run("non-200", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"nope"}`, http.StatusInternalServerError)
		})
		srv := httptest.NewServer(mux)
		defer srv.Close()

		_, err := client.fetchAuthorizationServerMetadata(context.Background(), srv.URL)
		require.Error(t, err)
	})

	t.Run("invalid-json", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			mustWrite(w, []byte(`{`))
		})
		srv := httptest.NewServer(mux)
		defer srv.Close()

		_, err := client.fetchAuthorizationServerMetadata(context.Background(), srv.URL)
		require.Error(t, err)
	})
}

func TestAuthorize_DefaultsAndNilContext(t *testing.T) {
	ctx := context.Background()

	// ---- Authorization Server stub ----
	var authBase string
	authMux := http.NewServeMux()
	authMux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, _ *http.Request) {
		md, err := oauthruntime.NewAuthorizationServerMetadata(authBase)
		require.NoError(t, err)
		b, err := md.MarshalJSONBytes()
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, b)
	})
	authMux.HandleFunc("/register", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		mustWrite(w, []byte(`{"client_id":"c1"}`))
	})
	authMux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		// Redirect URI defaults to Claude's callback.
		ru := r.URL.Query().Get("redirect_uri")
		require.NotEmpty(t, ru)
		http.Redirect(w, r, ru+"?code=code1", http.StatusFound)
	})
	authMux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		grantType := r.Form.Get("grant_type")
		switch grantType {
		case "authorization_code":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			mustWrite(w, []byte(`{"access_token":"a1","refresh_token":"r1","token_type":"Bearer"}`))
		case "refresh_token":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			mustWrite(w, []byte(`{"access_token":"a2","refresh_token":"r2","token_type":"Bearer"}`))
		default:
			http.Error(w, "unsupported", http.StatusBadRequest)
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
		if r.Header.Get("Authorization") == "" {
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

	cli := NewClaudePublicClient(nil)

	// Nil context should default to Background internally.
	//nolint:staticcheck // testing nil context handling
	_, _, _, _, err := cli.Authorize(nil, AuthorizeOptions{McpEndpoint: mcpBase + "/mcp/"})
	require.NoError(t, err)

	// Missing endpoint should fail closed.
	_, _, _, _, err = cli.Authorize(ctx, AuthorizeOptions{})
	require.Error(t, err)
}
