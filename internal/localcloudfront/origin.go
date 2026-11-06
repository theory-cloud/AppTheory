package localcloudfront

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Origin is the interface the local runner implements for the S3 emulator
// origin, the Lambda Function URL origin, and origin groups.
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
	// Range is the viewer Range header. CloudFront forwards Range to the
	// origin without putting it in a cache or origin request policy; the S3
	// origin applies it and other origins ignore it.
	Range string
	// CachedMethods is the selected behavior's CachedMethods. An origin group
	// fails over an OPTIONS request only when OPTIONS is listed:
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html
	CachedMethods []string
	// SuppressS3ResponseOverrides is set when the behavior's managed origin
	// request policy makes CloudFront drop response-content-type,
	// response-content-disposition and response-content-encoding from an S3
	// origin request. Only an S3 origin applies it.
	SuppressS3ResponseOverrides bool
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

// OriginUnavailableError reports an origin the local gateway cannot reach or
// serve. The gateway answers 503 with this reason; it never fakes the origin.
type OriginUnavailableError struct {
	OriginID string
	Reason   string
}

// Error names the origin and the reason it is unavailable locally.
func (e *OriginUnavailableError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("origin %q has no local implementation", e.OriginID)
	}
	return fmt.Sprintf("origin %q is not available locally: %s", e.OriginID, e.Reason)
}

// Unwrap lets callers test errors.Is(err, ErrOriginUnavailable).
func (e *OriginUnavailableError) Unwrap() error { return ErrOriginUnavailable }

// ErrOriginUnavailable is the sentinel for an origin the local gateway cannot
// serve.
var ErrOriginUnavailable = errors.New("origin is unavailable locally")

// originForTarget resolves the behavior target. A missing implementation is nil
// so the gateway can name the target.
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
