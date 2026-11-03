package localcloudfront

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// OriginGroupMember is one member of an origin group. OriginPath and Host are
// the member origin's own values: CloudFront applies each member's origin path
// and Host when it fails over, while the group request itself carries neither.
type OriginGroupMember struct {
	OriginID   string
	Origin     Origin
	OriginPath string
	Host       string
}

// OriginGroupOrigin implements CloudFront origin failover.
//
// AWS documents the failover rules: CloudFront routes a request to the primary
// member; when the primary returns a status code configured in
// FailoverCriteria, or CloudFront fails to connect (when 503 is configured) or
// the primary times out (when 504 is configured), it retries the secondary
// member with that member's origin path and Host. GET and HEAD always fail
// over; OPTIONS fails over only when the behavior caches OPTIONS in
// CachedMethods, and other methods go to the primary only.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html
type OriginGroupOrigin struct {
	GroupID             string
	Members             []OriginGroupMember
	FailoverStatusCodes []int
}

// NewOriginGroupOrigin builds a group with a primary and a secondary member.
func NewOriginGroupOrigin(groupID string, members []OriginGroupMember, codes []int) *OriginGroupOrigin {
	return &OriginGroupOrigin{GroupID: groupID, Members: members, FailoverStatusCodes: codes}
}

// Fetch sends the request to the primary member and fails over to the secondary
// when CloudFront would.
func (g *OriginGroupOrigin) Fetch(ctx context.Context, request OriginRequest) (OriginResponse, error) {
	if len(g.Members) < 2 {
		return OriginResponse{}, &OriginUnavailableError{
			OriginID: g.GroupID,
			Reason:   fmt.Sprintf("an origin group needs a primary and a secondary member; the assembly declares %d", len(g.Members)),
		}
	}
	primary := g.Members[0]
	secondary := g.Members[1]
	primaryRequest := memberRequest(request, primary)
	response, err := primary.Origin.Fetch(ctx, primaryRequest)
	if !failoverMethod(request) {
		return response, err
	}
	if err != nil {
		if !g.failsOverOn(failoverStatusForError(err)) {
			return response, err
		}
		return secondary.Origin.Fetch(ctx, memberRequest(request, secondary))
	}
	if !g.failsOverOn(response.StatusCode) {
		return response, nil
	}
	return secondary.Origin.Fetch(ctx, memberRequest(request, secondary))
}

// memberRequest applies the member's origin path and Host. A request Host that
// the origin request policy forwarded from the viewer is kept for both members;
// otherwise the member origin domain is used.
func memberRequest(request OriginRequest, member OriginGroupMember) OriginRequest {
	request.OriginPath = member.OriginPath
	if request.Host == "" {
		request.Host = member.Host
	}
	return request
}

func failoverMethod(request OriginRequest) bool {
	switch request.Method {
	case http.MethodGet, http.MethodHead:
		return true
	case http.MethodOptions:
		return methodListed(request.CachedMethods, http.MethodOptions)
	default:
		return false
	}
}

func methodListed(methods []string, want string) bool {
	for _, method := range methods {
		if strings.EqualFold(method, want) {
			return true
		}
	}
	return false
}

func (g *OriginGroupOrigin) failsOverOn(status int) bool {
	for _, code := range g.FailoverStatusCodes {
		if code == status {
			return true
		}
	}
	return false
}

// failoverStatusForError maps a failed primary fetch to the failover criterion
// CloudFront uses: a timeout is a 504 and every other connection failure is a
// 503. The group fails over only when that status is configured.
func failoverStatusForError(err error) int {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return http.StatusGatewayTimeout
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	return http.StatusServiceUnavailable
}
