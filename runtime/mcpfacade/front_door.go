package mcpfacade

import (
	"context"
	"crypto/subtle"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"

	apptheory "github.com/theory-cloud/apptheory/v7/runtime"
)

// DefaultFrontDoorSecretTTL is how long a front-door secret read from Parameter
// Store is reused in one execution environment when FacadeConfig leaves
// FrontDoorSecretTTL unset.
const DefaultFrontDoorSecretTTL = 5 * time.Minute

// MaxFrontDoorSecretTTL is the largest accepted FrontDoorSecretTTL. A longer
// cache would let a rotated-out value stay accepted for longer than the
// documented rotation window.
const MaxFrontDoorSecretTTL = time.Hour

// frontDoorSecretRefreshFloor bounds how often a mismatching request may force a
// Parameter Store read. A rotated value is picked up within this floor, and a
// caller that sends bogus headers cannot drive one read per request.
const frontDoorSecretRefreshFloor = time.Second

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
	errFrontDoorSecretForms = errors.New(
		"mcpfacade: FrontDoorVerification requires exactly one of SecretValue and SecretParameterName",
	)
	errInvalidFrontDoorParameterName = errors.New(
		"mcpfacade: FrontDoorVerification SecretParameterName must be a fully qualified SSM parameter name of at most 1011 characters and fifteen levels, of [A-Za-z0-9_.-/], outside the aws and ssm hierarchies",
	)
	errInvalidFrontDoorSecretTTL = errors.New(
		"mcpfacade: FrontDoorSecretTTL must be greater than zero and at most one hour",
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
// origin is the execute-api hostname) injects HeaderName: <secret> on every
// origin request. Supply the secret as exactly one of two forms:
//
//   - SecretValue is the v7.3 literal. Three copies of that value must come from
//     one application-owned constant — the CDK construct prop (digest only), the
//     distribution's origin custom-header configuration, and this config.
//   - SecretParameterName names a well-known, stage-qualified Parameter Store
//     parameter. The value is read lazily in the request path (never by a
//     goroutine or background timer), cached for FrontDoorSecretTTL, and
//     re-read on a verification mismatch so a rotation takes effect without a
//     redeploy. The CDK construct's frontDoorOriginHeader renders the matching
//     CloudFormation dynamic reference for the distribution.
type FrontDoorVerification struct {
	// HeaderName is the origin request header the front door injects. 1 to 64
	// characters of [A-Za-z0-9-], and never a request header that rewrites the
	// origin contract.
	HeaderName string
	// SecretValue is the literal header value. 32 to 128 characters of
	// [A-Za-z0-9._~-]. It is compared in constant time on every request.
	SecretValue string
	// SecretParameterName is the well-known SSM parameter that holds the header
	// value, mutually exclusive with SecretValue. The parameter must be type
	// String: CloudFront's origin custom headers support the plaintext
	// CloudFormation "ssm" dynamic reference only. The runtime reads it with
	// decryption enabled, so a SecureString would also read, but it could not
	// feed the distribution header.
	SecretParameterName string
}

// frontDoorHeaderNamePattern is the accepted front-door header name alphabet.
var frontDoorHeaderNamePattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// frontDoorSecretPattern is the accepted front-door secret alphabet: a
// header-value-safe alphabet with no whitespace and no control characters.
var frontDoorSecretPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{32,128}$`)

// frontDoorParameterNamePattern is the alphabet a CloudFormation "ssm" dynamic
// reference accepts, which is also the Parameter Store name alphabet plus the
// hierarchy separator.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-ssm.html
var frontDoorParameterNamePattern = regexp.MustCompile(`^/[A-Za-z0-9_.\-/]+$`)

const (
	frontDoorParameterMaxLength = 1011
	frontDoorParameterMaxLevels = 15
)

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
	reader FrontDoorSecretReader,
	ttl time.Duration,
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
		guard, err := newFrontDoorGuard(*verification, reader, ttl)
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
//
// The literal form compares the configured value. The parameter form reads the
// well-known parameter lazily in the request path, so no goroutine and no timer
// outlives an invocation, and fails closed: an unreadable, empty, or malformed
// parameter refuses the request with the same 403 a direct-origin request gets.
func newFrontDoorGuard(
	verification FrontDoorVerification,
	reader FrontDoorSecretReader,
	ttl time.Duration,
) (apptheory.RouteGuard, error) {
	headerName, err := validateFrontDoorHeaderName(verification.HeaderName)
	if err != nil {
		return nil, err
	}
	hasLiteral := verification.SecretValue != ""
	hasParameter := verification.SecretParameterName != ""
	if hasLiteral == hasParameter {
		return nil, errFrontDoorSecretForms
	}
	if hasParameter {
		return newFrontDoorParameterGuard(headerName, verification.SecretParameterName, reader, ttl)
	}
	if !frontDoorSecretPattern.MatchString(verification.SecretValue) {
		return nil, errInvalidFrontDoorSecret
	}
	return newFrontDoorLiteralGuard(headerName, verification.SecretValue), nil
}

// validateFrontDoorHeaderName accepts a request header the front door can set
// and returns its normalized name.
func validateFrontDoorHeaderName(raw string) (string, error) {
	headerName := strings.ToLower(strings.TrimSpace(raw))
	if !frontDoorHeaderNamePattern.MatchString(headerName) {
		return "", errInvalidFrontDoorHeaderName
	}
	if _, reserved := reservedFrontDoorHeaders[headerName]; reserved ||
		strings.HasPrefix(headerName, "x-amz-") ||
		strings.HasPrefix(headerName, "x-amzn-") ||
		strings.HasPrefix(headerName, "cloudfront-") {
		return "", errReservedFrontDoorHeaderName
	}
	return headerName, nil
}

// newFrontDoorParameterGuard builds the guard that reads the parameter lazily.
func newFrontDoorParameterGuard(
	headerName, parameterName string,
	reader FrontDoorSecretReader,
	ttl time.Duration,
) (apptheory.RouteGuard, error) {
	if err := validateFrontDoorParameterName(parameterName); err != nil {
		return nil, err
	}
	if ttl == 0 {
		ttl = DefaultFrontDoorSecretTTL
	}
	if ttl < 0 || ttl > MaxFrontDoorSecretTTL {
		return nil, errInvalidFrontDoorSecretTTL
	}
	if reader == nil {
		reader = defaultFrontDoorSecretReader()
	}
	cache := &frontDoorSecretCache{reader: reader, headerName: headerName, name: parameterName, ttl: ttl}
	return frontDoorParameterGuard(cache), nil
}

// validateFrontDoorParameterName checks the name against both contracts it must
// satisfy: Parameter Store's naming limits and the CloudFormation dynamic
// reference alphabet the distribution header renders.
func validateFrontDoorParameterName(name string) error {
	if len(name) == 0 ||
		len(name) > frontDoorParameterMaxLength ||
		!frontDoorParameterNamePattern.MatchString(name) ||
		strings.HasSuffix(name, "/") ||
		strings.Contains(name, "//") {
		return errInvalidFrontDoorParameterName
	}
	levels := strings.Split(strings.TrimPrefix(name, "/"), "/")
	if len(levels) == 0 || len(levels) > frontDoorParameterMaxLevels {
		return errInvalidFrontDoorParameterName
	}
	switch strings.ToLower(levels[0]) {
	case "aws", "ssm":
		return errInvalidFrontDoorParameterName
	}
	return nil
}

// newFrontDoorLiteralGuard compares the literal header value in constant time.
func newFrontDoorLiteralGuard(headerName, secretValue string) apptheory.RouteGuard {
	expected := []byte(secretValue)
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		if ctx == nil {
			return nil, frontDoorRefusal()
		}
		if !frontDoorSecretEqual([]byte(ctx.Header(headerName)), expected) {
			return nil, frontDoorRefusal()
		}
		return nil, nil
	}
}

// frontDoorParameterGuard verifies the header against the parameter value.
//
// A mismatch forces one refresh (subject to frontDoorSecretRefreshFloor) and a
// second comparison, so the first request that carries a rotated value is
// admitted. A read failure, an empty value, or a value outside the documented
// alphabet refuses the request; the route is never left open.
func frontDoorParameterGuard(cache *frontDoorSecretCache) apptheory.RouteGuard {
	return func(ctx *apptheory.Context) (*apptheory.Response, error) {
		if ctx == nil {
			return nil, frontDoorRefusal()
		}
		requestCtx := ctx.Context()
		if requestCtx == nil {
			requestCtx = context.Background()
		}
		presented := []byte(ctx.Header(cache.headerName))
		expected, err := cache.secret(requestCtx, false)
		if err != nil {
			return nil, frontDoorRefusal()
		}
		if frontDoorSecretEqual(presented, []byte(expected)) {
			return nil, nil
		}
		expected, err = cache.secret(requestCtx, true)
		if err != nil {
			return nil, frontDoorRefusal()
		}
		if frontDoorSecretEqual(presented, []byte(expected)) {
			return nil, nil
		}
		return nil, frontDoorRefusal()
	}
}

// frontDoorSecretEqual compares two header values in constant time. The length
// guard is required: subtle.ConstantTimeCompare returns immediately on unequal
// lengths, and both length and content are already client-visible.
func frontDoorSecretEqual(presented, expected []byte) bool {
	return len(presented) == len(expected) && subtle.ConstantTimeCompare(presented, expected) == 1
}

// frontDoorSecretCache holds one execution environment's view of a front-door
// parameter.
//
// The read happens under the mutex, in the request path, so concurrent requests
// coalesce onto one Parameter Store call and no work outlives the invocation.
type frontDoorSecretCache struct {
	mu         sync.Mutex
	reader     FrontDoorSecretReader
	headerName string
	name       string
	ttl        time.Duration
	value      string
	fetchedAt  time.Time
	lastReadAt time.Time
}

// secret returns the cached value while it is fresh, and otherwise reads the
// parameter. A forced read is bounded by frontDoorSecretRefreshFloor.
func (c *frontDoorSecretCache) secret(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if !force && c.value != "" && now.Sub(c.fetchedAt) < c.ttl {
		return c.value, nil
	}
	if force && c.value != "" && now.Sub(c.lastReadAt) < frontDoorSecretRefreshFloor {
		return c.value, nil
	}
	c.lastReadAt = now
	value, err := c.reader(ctx, c.name)
	if err != nil {
		return "", err
	}
	if !frontDoorSecretPattern.MatchString(value) {
		return "", errInvalidFrontDoorSecret
	}
	c.value = value
	c.fetchedAt = now
	return value, nil
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

// applyFrontDoorGuard attaches the front-door check to every derived route in
// the construct's inventory (transport and OAuth facade). The guard is appended
// to each route's options ahead of the transport credential guard, so a request
// that did not arrive through the declared front door is refused before any
// other admission work.
func applyFrontDoorGuard(
	registrations []routeRegistration,
	guard apptheory.RouteGuard,
) []routeRegistration {
	guarded := make([]routeRegistration, len(registrations))
	for index, registration := range registrations {
		registration.options = append(
			append([]apptheory.RouteOption(nil), registration.options...),
			apptheory.WithRouteGuard(guard),
		)
		guarded[index] = registration
	}
	return guarded
}
