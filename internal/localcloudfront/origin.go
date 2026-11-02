package localcloudfront

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Origin is the interface A5b implements for the S3 emulator origin, the
// Lambda Function URL origin through the runner, and origin groups.
//
// The gateway selects the behavior, runs the viewer-request function and
// applies the cache and origin request policies before calling the origin. The
// origin receives the viewer-modified URI without the origin path, the policy-
// filtered query and headers, and the Host the policy chose. An origin group
// receives OriginPath empty and is responsible for applying each member's
// origin path and Host.
type Origin interface {
	Fetch(ctx context.Context, request OriginRequest) (OriginResponse, error)
}

// OriginFunc adapts a function to Origin.
type OriginFunc func(ctx context.Context, request OriginRequest) (OriginResponse, error)

// Fetch calls the function.
func (f OriginFunc) Fetch(ctx context.Context, request OriginRequest) (OriginResponse, error) {
	return f(ctx, request)
}

// OriginRequest is what the gateway sends to an origin.
type OriginRequest struct {
	// OriginID is the behavior's TargetOriginId: an origin id or an origin
	// group id.
	OriginID string
	// Method is the viewer method; a viewer-request function cannot change it.
	Method string
	// URI is the viewer path after the viewer-request function and the
	// distribution's DefaultRootObject. It never contains OriginPath.
	URI string
	// OriginPath is the selected origin's OriginPath. It is empty for an origin
	// group because a group's failover member can have a different path.
	OriginPath string
	// Query is the policy-filtered raw query string, without a leading "?".
	Query string
	// Host is the origin Host. A managed policy that forwards the viewer Host
	// puts the viewer host here; otherwise it is the single origin's domain. It
	// is empty for an origin group that does not forward the viewer Host.
	Host string
	// Header carries the policy-filtered headers. Host and Cookie are set on
	// Host and in this map respectively, never duplicated.
	Header http.Header
	Body   []byte
	// ViewerIP is the viewer address the gateway observed.
	ViewerIP string
	// RequestID is the CloudFront request id used in the function event.
	RequestID string
	// DistributionID is the local distribution id used in the function event.
	DistributionID string
}

// Path returns the path an origin should request: OriginPath followed by URI.
func (r OriginRequest) Path() string {
	if r.OriginPath == "" {
		return r.URI
	}
	return strings.TrimSuffix(r.OriginPath, "/") + "/" + strings.TrimPrefix(r.URI, "/")
}

// OriginResponse is an origin response.
type OriginResponse struct {
	StatusCode        int
	StatusDescription string
	Header            http.Header
	Body              []byte
}

// OriginNotWiredError reports an origin the gateway has no implementation for.
// A5a deliberately returns this instead of faking an origin.
type OriginNotWiredError struct {
	OriginID string
}

// Error names the origin and the milestone that wires it.
func (e *OriginNotWiredError) Error() string {
	return fmt.Sprintf("origin %q is not wired until A5b", e.OriginID)
}

// Unwrap lets callers test errors.Is(err, ErrOriginNotWired).
func (e *OriginNotWiredError) Unwrap() error { return ErrOriginNotWired }

// ErrOriginNotWired is the sentinel for an unwired origin.
var ErrOriginNotWired = errors.New("origin is not wired until A5b")

// originForTarget resolves the behavior target. A missing implementation is an
// OriginNotWiredError naming either the origin or the group.
func (g *Gateway) originForTarget(targetID string) (Origin, *DistributionOrigin, *OriginGroup) {
	origin, isOrigin := g.Distribution.Origin(targetID)
	group, isGroup := g.Distribution.OriginGroup(targetID)
	if isOrigin {
		return g.Origins[targetID], origin, nil
	}
	if isGroup {
		return g.Origins[targetID], nil, group
	}
	return nil, nil, nil
}
