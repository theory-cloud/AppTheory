package mcpfacade

import (
	"crypto/subtle"
	"errors"
	"regexp"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
)

var (
	errInvalidOriginReachability = errors.New(
		"mcpfacade: OriginReachability must be disabled, locked, or fronted",
	)
	errFrontedWithoutVerification = errors.New(
		"mcpfacade: OriginReachability fronted requires FrontDoorVerification",
	)
	errFrontDoorVerificationWithoutFronted = errors.New(
		"mcpfacade: FrontDoorVerification is only valid with OriginReachability fronted",
	)
	errInvalidFrontDoorHeaderName = errors.New(
		"mcpfacade: FrontDoorVerification header name must be 1 to 64 characters of [A-Za-z0-9-]",
	)
	errReservedFrontDoorHeaderName = errors.New(
		"mcpfacade: FrontDoorVerification header name must be a request header the front door can set",
	)
	errInvalidFrontDoorSecret = errors.New(
		"mcpfacade: FrontDoorVerification secret value must be 32 to 128 characters of [A-Za-z0-9._~-]",
	)
)

// OriginReachability is the declared direct-origin posture of the front door
// that fronts this facade.
//
// The value mirrors the CDK construct's AppTheoryMcpOriginReachability decision,
// so one application-owned constant can feed both the construct prop and this
// config. Only OriginReachabilityFronted changes runtime behavior: disabled and
// locked are enforced at the edge, where the construct proves them, and are
// recorded here so the runtime can refuse a contradictory front-door
// declaration instead of silently ignoring it.
type OriginReachability string

const (
	// OriginReachabilityDisabled is the edge-enforced disabled execute-api
	// endpoint posture. It carries no runtime check.
	OriginReachabilityDisabled OriginReachability = "disabled"
	// OriginReachabilityLocked is the edge-enforced mutual-TLS posture. It
	// carries no runtime check.
	OriginReachabilityLocked OriginReachability = "locked"
	// OriginReachabilityFronted requires FrontDoorVerification: every derived
	// route refuses a request whose declared front-door header is absent or
	// wrong.
	OriginReachabilityFronted OriginReachability = "fronted"
)

// FrontDoorVerification declares the app-owned front-door header this runtime
// verifies on every derived route under OriginReachabilityFronted.
//
// The front door (for example an application-owned CloudFront distribution whose
// origin is the execute-api hostname) injects HeaderName: SecretValue on every
// origin request. Three copies of that value must come from one
// application-owned constant — the CDK construct prop (digest only), the
// distribution's origin custom-header configuration, and this config — because
// the runtime shares routes with the construct, never configuration
// environment variables.
type FrontDoorVerification struct {
	// HeaderName is the origin request header the front door injects. 1 to 64
	// characters of [A-Za-z0-9-], and never a request header that rewrites the
	// origin contract.
	HeaderName string
	// SecretValue is the literal header value. 32 to 128 characters of
	// [A-Za-z0-9._~-]. It is compared in constant time on every request.
	SecretValue string
}

// frontDoorHeaderNamePattern is the accepted front-door header name alphabet.
var frontDoorHeaderNamePattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// frontDoorSecretPattern is the accepted front-door secret alphabet: a
// header-value-safe alphabet with no whitespace and no control characters.
var frontDoorSecretPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{32,128}$`)

// reservedFrontDoorHeaders are request headers that rewrite the origin request
// contract or are platform-managed, so they can never carry the front-door
// verification.
var reservedFrontDoorHeaders = map[string]struct{}{
	"authorization":     {},
	"connection":        {},
	"content-length":    {},
	"cookie":            {},
	"host":              {},
	"transfer-encoding": {},
	"www-authenticate":  {},
	"x-forwarded-for":   {},
}

// normalizeOriginReachability resolves the declared origin posture and the
// front-door verification into the request-time guard.
//
// An empty posture stays valid (an application that does not share the
// construct's posture record keeps its v7 behavior), but FRONTED without the
// verification config fails registration: a declared front door the runtime does
// not enforce would be a silent no-op.
func normalizeOriginReachability(
	posture OriginReachability,
	verification *FrontDoorVerification,
) (OriginReachability, apptheory.RouteGuard, error) {
	switch posture {
	case "":
		if verification != nil {
			return "", nil, errFrontDoorVerificationWithoutFronted
		}
		return "", nil, nil
	case OriginReachabilityDisabled, OriginReachabilityLocked:
		if verification != nil {
			return "", nil, errFrontDoorVerificationWithoutFronted
		}
		return posture, nil, nil
	case OriginReachabilityFronted:
		if verification == nil {
			return "", nil, errFrontedWithoutVerification
		}
		guard, err := newFrontDoorGuard(*verification)
		if err != nil {
			return "", nil, err
		}
		return posture, guard, nil
	default:
		return "", nil, errInvalidOriginReachability
	}
}

// newFrontDoorGuard validates the declaration and returns the guard that
// refuses every request whose front-door header is absent or wrong.
func newFrontDoorGuard(verification FrontDoorVerification) (apptheory.RouteGuard, error) {
	headerName := strings.ToLower(strings.TrimSpace(verification.HeaderName))
	if !frontDoorHeaderNamePattern.MatchString(headerName) {
		return nil, errInvalidFrontDoorHeaderName
	}
	if _, reserved := reservedFrontDoorHeaders[headerName]; reserved ||
		strings.HasPrefix(headerName, "x-amz-") ||
		strings.HasPrefix(headerName, "x-amzn-") ||
		strings.HasPrefix(headerName, "cloudfront-") {
		return nil, errReservedFrontDoorHeaderName
	}
	if !frontDoorSecretPattern.MatchString(verification.SecretValue) {
		return nil, errInvalidFrontDoorSecret
	}
	expected := []byte(verification.SecretValue)
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		if ctx == nil {
			return nil, frontDoorRefusal()
		}
		presented := []byte(ctx.Header(headerName))
		if len(presented) != len(expected) ||
			subtle.ConstantTimeCompare(presented, expected) != 1 {
			return nil, frontDoorRefusal()
		}
		return nil, nil
	}, nil
}

// frontDoorRefusal is the fail-closed answer to a request that did not arrive
// through the declared front door. It is a plain 403 with no hint about which
// header or value the front door uses.
func frontDoorRefusal() error {
	return &apptheory.AppTheoryError{
		Code:       "app.forbidden",
		Message:    "forbidden",
		StatusCode: 403,
	}
}
