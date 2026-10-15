package oauth

import (
	"context"
	"errors"
	"time"
)

// Provider is the provider-neutral upstream IdP adapter SPI of the MCP auth
// facade (DESIGN §6, contract fixture facade-provider-spi.v1.json).
//
// The SPI is deliberately the minimum needed to derive the facade from the
// upstream requirements, so provider-specific policy travels through hints and
// typed errors rather than framework branches. Every method is fail-closed: it
// never relaxes a check, never mutates the token it is given, and never
// forwards an upstream response body to its caller. Failures are reported as a
// typed *ProviderError carrying the provider error class the facade maps onto
// the closed client-facing vocabulary.
type Provider interface {
	// Discovery returns the upstream metadata after verifying the discovery
	// document: the document issuer must equal the configured issuer before any
	// published endpoint is trusted.
	Discovery(ctx context.Context) (*ProviderMetadata, error)

	// AuthorizationURL builds the absolute upstream authorize URL a browser is
	// redirected to from the facade's /authorize surface.
	AuthorizationURL(req AuthorizationRequest) (string, error)

	// ExchangeCode performs the server-side upstream code exchange, presenting
	// the facade's own client and PKCE verifier.
	ExchangeCode(ctx context.Context, req CodeExchangeRequest) (*TokenSet, error)

	// Refresh performs an upstream refresh presenting the OAuth client that owns
	// the recorded upstream material.
	Refresh(ctx context.Context, req RefreshRequest) (*TokenSet, error)

	// ValidateAccessToken validates an upstream access token against the caller's
	// expectations and returns safe, non-secret claims. It never mutates the
	// token.
	ValidateAccessToken(ctx context.Context, token string, expected TokenExpectations) (*TokenClaims, error)
}

// ProviderMetadata is the verified upstream discovery document subset the
// facade relies on.
type ProviderMetadata struct {
	Issuer                                     string   `json:"issuer"`
	AuthorizationEndpoint                      string   `json:"authorization_endpoint"`
	TokenEndpoint                              string   `json:"token_endpoint"`
	JWKSURI                                    string   `json:"jwks_uri"`
	CodeChallengeMethodsSupported              []string `json:"code_challenge_methods_supported"`
	AuthorizationResponseIssParameterSupported bool     `json:"authorization_response_iss_parameter_supported"`
	ResourceParameterSupported                 bool     `json:"resource_parameter_supported"`
}

// AuthorizationRequest is one upstream authorize request. State is a fresh
// upstream state distinct from the client's state, and Hints carries opaque
// provider hints (for example account_id): a provider derives authentication
// account context from its own validated binding, never from a hint.
type AuthorizationRequest struct {
	UpstreamClientID    string
	CallbackURL         string
	CodeChallenge       string
	CodeChallengeMethod string
	State               string
	Resource            string
	Scopes              []string
	Hints               map[string]string
}

// CodeExchangeRequest is one server-side upstream code exchange.
type CodeExchangeRequest struct {
	Code             string
	UpstreamClientID string
	CallbackURL      string
	CodeVerifier     string
}

// RefreshRequest is one upstream refresh. UpstreamClientID is the OAuth client
// that owns the recorded upstream material: the facade's own client for
// facade-opened records, the client's own id for pre-facade records.
type RefreshRequest struct {
	RefreshMaterial  string
	UpstreamClientID string
}

// TokenExpectations is the caller's expectation set for access-token
// validation. AllowedAuthorizedParties is an exact-match allow-list for the
// token's azp claim (falling back to client_id); an empty list disables that
// check.
type TokenExpectations struct {
	ExpectedIssuer           string
	ExpectedAudience         string
	RequiredScopes           []string
	AllowedAuthorizedParties []string
}

// TokenSet is one upstream token response. The adapter never drops an upstream
// field the facade may need: the access token is returned to the client
// byte-for-byte unmodified, while refresh material and any id_token never reach
// the client.
type TokenSet struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	IDToken      string `json:"id_token"`
}

// TokenClaims is the safe, non-secret claim subset ValidateAccessToken returns.
type TokenClaims struct {
	Subject         string    `json:"subject"`
	Audience        string    `json:"audience"`
	Scopes          []string  `json:"scopes"`
	ExpiresAt       time.Time `json:"expires_at"`
	AuthorizedParty string    `json:"authorized_party"`
}

// ProviderErrorClass is the closed provider error vocabulary of DESIGN §6. It
// maps onto the facade's client-facing classes and HTTP statuses.
type ProviderErrorClass string

// ProviderErrorClass values. Every class is reachable from an explicit adapter
// decision; none is inferred from a raw upstream body.
const (
	// ProviderUpstreamError is an upstream provider failure (facade HTTP 502).
	ProviderUpstreamError ProviderErrorClass = "upstream_error"
	// ProviderTemporarilyUnavailable is a transient, retryable provider failure
	// (facade HTTP 503).
	ProviderTemporarilyUnavailable ProviderErrorClass = "temporarily_unavailable"
	// ProviderInvalidGrant means the provider definitively rejected the grant
	// (terminal; facade HTTP 400).
	ProviderInvalidGrant ProviderErrorClass = "invalid_grant"
	// ProviderInvalidRequest means the adapter was called with a request it
	// cannot send; it never reaches the upstream (facade HTTP 400).
	ProviderInvalidRequest ProviderErrorClass = "invalid_request"
	// ProviderReauthRequired means the provider reported the recorded material
	// stale or replaced (terminal; facade HTTP 400).
	ProviderReauthRequired ProviderErrorClass = "reauth_required"
)

// ProviderError is the typed error every provider adapter returns. Message is a
// fixed adapter string and never contains any part of an upstream response
// body; the attached cause is only ever a transport failure (an errors.Is /
// errors.As target), so rendering an error can never echo upstream material.
type ProviderError struct {
	Class   ProviderErrorClass
	Op      string
	Message string

	cause error
}

// NewProviderError returns a ProviderError for class and operation with a fixed
// message.
func NewProviderError(class ProviderErrorClass, op string, message string) *ProviderError {
	return &ProviderError{Class: class, Op: op, Message: message}
}

// Error implements error. The rendered string is the class, the operation, the
// fixed message, and the transport cause: no upstream response body is ever
// part of it.
func (e *ProviderError) Error() string {
	if e == nil {
		return ""
	}
	rendered := "oauth provider"
	if e.Op != "" {
		rendered += " " + e.Op
	}
	rendered += ": " + string(e.Class) + ": " + e.Message
	if e.cause != nil {
		rendered += ": " + e.cause.Error()
	}
	return rendered
}

// Unwrap returns the underlying cause so errors.Is/errors.As can classify the
// transport failure that produced the class.
func (e *ProviderError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

// HTTPStatus maps the class onto the facade's client-facing status.
func (e *ProviderError) HTTPStatus() int {
	if e == nil {
		return 500
	}
	switch e.Class {
	case ProviderUpstreamError:
		return 502
	case ProviderTemporarilyUnavailable:
		return 503
	case ProviderInvalidGrant, ProviderInvalidRequest, ProviderReauthRequired:
		return 400
	default:
		return 500
	}
}

// withCause returns a copy of e that wraps cause. It never mutates e, so a
// package-level class helper stays safe to share.
func (e *ProviderError) withCause(cause error) *ProviderError {
	if e == nil {
		return nil
	}
	clone := *e
	clone.cause = cause
	return &clone
}

// AsProviderError reports whether err is (or wraps) a *ProviderError.
func AsProviderError(err error) (*ProviderError, bool) {
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		return nil, false
	}
	return providerErr, true
}

// providerClassError is the shared constructor for the adapter's fixed-message
// errors.
func providerClassError(class ProviderErrorClass, op, message string, cause error) *ProviderError {
	if cause == nil {
		return NewProviderError(class, op, message)
	}
	return NewProviderError(class, op, message).withCause(cause)
}
