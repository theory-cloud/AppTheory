package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// The runner serves a local OIDC issuer for every provisioned Cognito user
// pool. Moto serves the pool's JWKS only at the path-style
// /{poolId}/.well-known/jwks.json, while a Cognito token names its issuer as
// https://cognito-idp.{region}.amazonaws.com/{poolId}:
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
//
// The local issuer is the same provider path on the runner's loopback listener:
//
//	http://127.0.0.1:<port>/cognito-idp/<region>/<poolId>
//
// At that issuer both documents resolve:
//
//	{issuer}/.well-known/jwks.json           -> the pool's JWKS from moto
//	{issuer}/.well-known/openid-configuration -> a local discovery document
//
// This is the URL R2a validates tokens against; it is an ordinary OIDC issuer,
// not a moto-specific path.

// cognitoIssuerPath is the path prefix before the pool id.
const cognitoIssuerPath = "/cognito-idp/"

// startCognitoIssuer starts the loopback issuer listener when the run
// provisioned at least one user pool. It is additive: a run without Cognito
// starts no listener.
func (r *Runner) startCognitoIssuer(ctx context.Context, _ *Spec) error {
	pools := r.cognitoPools()
	if len(pools) == 0 {
		return nil
	}
	listenConfig := net.ListenConfig{}
	listener, err := listenConfig.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("bind the Cognito issuer listener: %w", err)
	}
	base := "http://" + listener.Addr().String()
	handler := &cognitoIssuerHandler{
		pools:      pools,
		region:     LocalRegion,
		backendURL: r.cognitoBackendURL(),
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				Proxy:             nil,
				DisableKeepAlives: true,
			},
		},
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	r.listeners = append(r.listeners, listener)
	r.servers = append(r.servers, server)
	for key, value := range r.resourceValues {
		if value.Type != typeCognitoUserPool {
			continue
		}
		value.LocalIssuer = base + cognitoIssuerPath + LocalRegion + "/" + value.Name
		r.resourceValues[key] = value
	}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil &&
			serveErr != http.ErrServerClosed && !strings.Contains(serveErr.Error(), "use of closed network connection") {
			r.logf("Cognito issuer listener stopped: %v", serveErr)
		}
	}()
	r.logf("serving the Cognito issuer at %s%s<region>/<poolId>", base, cognitoIssuerPath)
	return nil
}

func (r *Runner) cognitoPools() map[string]bool {
	pools := map[string]bool{}
	for _, value := range r.resourceValues {
		if value.Type == typeCognitoUserPool && value.Name != "" {
			pools[value.Name] = true
		}
	}
	return pools
}

func (r *Runner) cognitoBackendURL() string {
	backend, ok := r.backendForService(backendCognito)
	if !ok {
		return ""
	}
	return backend.HostURL
}

// cognitoIssuerHandler serves the two OIDC documents for each provisioned pool.
type cognitoIssuerHandler struct {
	pools      map[string]bool
	region     string
	backendURL string
	client     *http.Client
}

func (h *cognitoIssuerHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	poolID, document, ok := h.parse(request.URL.Path)
	if !ok {
		http.NotFound(writer, request)
		return
	}
	switch document {
	case "jwks.json":
		h.serveJWKS(writer, request, poolID)
	case "openid-configuration":
		h.serveDiscovery(writer, request, poolID)
	default:
		http.NotFound(writer, request)
	}
}

func (h *cognitoIssuerHandler) parse(path string) (string, string, bool) {
	trimmed := strings.TrimPrefix(path, cognitoIssuerPath)
	parts := strings.Split(trimmed, "/")
	if len(parts) != 4 || parts[0] != h.region || parts[2] != ".well-known" {
		return "", "", false
	}
	if !h.pools[parts[1]] {
		return "", "", false
	}
	switch parts[3] {
	case "jwks.json", "openid-configuration":
		return parts[1], parts[3], true
	default:
		return "", "", false
	}
}

func (h *cognitoIssuerHandler) serveJWKS(writer http.ResponseWriter, request *http.Request, poolID string) {
	if h.backendURL == "" {
		http.Error(writer, "the cognito-idp backend is not running", http.StatusServiceUnavailable)
		return
	}
	// Moto serves the documented path-style JWKS only:
	// /{poolId}/.well-known/jwks.json.
	url := strings.TrimSuffix(h.backendURL, "/") + "/" + poolID + "/.well-known/jwks.json"
	//nolint:gosec // url is the trusted loopback backend plus a pool id validated above.
	upstream, err := http.NewRequestWithContext(request.Context(), http.MethodGet, url, nil)
	if err != nil {
		http.Error(writer, "build the JWKS request", http.StatusBadGateway)
		return
	}
	//nolint:gosec // the request targets the trusted loopback backend.
	response, err := h.client.Do(upstream)
	if err != nil {
		http.Error(writer, "read the pool JWKS: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer response.Body.Close() //nolint:errcheck // the copied body is the response
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		http.Error(writer, "read the pool JWKS body", http.StatusBadGateway)
		return
	}
	if response.StatusCode != http.StatusOK {
		http.Error(writer, "the pool JWKS endpoint returned "+response.Status, http.StatusBadGateway)
		return
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		http.Error(writer, "the pool JWKS is not JSON", http.StatusBadGateway)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(body) //nolint:errcheck // response already committed
}

func (h *cognitoIssuerHandler) serveDiscovery(writer http.ResponseWriter, request *http.Request, poolID string) {
	issuer := "http://" + request.Host + cognitoIssuerPath + h.region + "/" + poolID
	document := map[string]any{
		"issuer":                                issuer,
		"jwks_uri":                              issuer + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code", "token"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"},
		"scopes_supported":                      []string{"openid", "email", "profile"},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		http.Error(writer, "encode the discovery document", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(encoded) //nolint:errcheck // response already committed
}
