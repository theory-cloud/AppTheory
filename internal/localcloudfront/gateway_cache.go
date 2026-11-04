package localcloudfront

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Gateway caching helpers.

func (g *Gateway) now() time.Time {
	if g.Now != nil {
		return g.Now().UTC()
	}
	return time.Now().UTC()
}

// cacheable reports whether the behavior caches the method. The cache policy's
// CachingDisabled and an empty policy both bypass the cache.
func (g *Gateway) cacheable(behavior *Behavior, method string) bool {
	if behavior == nil || behavior.CachePolicy == nil || behavior.CachePolicy.Cache == nil {
		return false
	}
	if behavior.CachePolicy.Cache.CachingDisabled {
		return false
	}
	methods := behavior.CachedMethods
	if len(methods) == 0 {
		methods = []string{http.MethodGet, http.MethodHead}
	}
	for _, cached := range methods {
		if equalMethod(cached, method) {
			return true
		}
	}
	return false
}

func equalMethod(left, right string) bool { return strings.EqualFold(left, right) }

// respondFromCache serves one cached entry with the documented hit headers and
// runs the viewer-response function and response headers policy as CloudFront
// does for every request served from the cache.
func (g *Gateway) respondFromCache(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	state *requestState,
	requestID, domainName string,
	entry CacheEntry,
	now time.Time,
	note string,
) {
	age := int(now.Sub(entry.StoredAt).Seconds())
	if age < 0 {
		age = 0
	}
	response := entry.Response
	if conditional, ok := notModifiedFromCache(request.Header, entry.Response); ok {
		// A cached object's validators answer a conditional viewer request with
		// 304 without reaching the origin, as CloudFront does.
		response = conditional
	}
	g.finishResponse(writer, request, behavior, state, requestID, domainName, response, cacheHitHeader, age)
	if note != "" {
		g.logf("cloudfront %s %s %s -> %d (cached: %s, age %ds)",
			g.Distribution.LogicalID, request.Method, request.URL.EscapedPath(), entry.Response.StatusCode, note, age)
	}
}

// refreshInBackground re-fetches a stale entry while the stale response is
// served, which is what stale-while-revalidate asks for.
func (g *Gateway) refreshInBackground(origin Origin, originRequest OriginRequest, behavior *Behavior, key string) {
	if origin == nil {
		return
	}
	request := originRequest
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		response, err := origin.Fetch(ctx, request)
		if err != nil {
			return
		}
		final, errorTTL := g.applyCustomErrorResponse(ctx, origin, request, response)
		ttl, control := g.responseTTL(final, behavior, errorTTL)
		if ttl <= 0 {
			return
		}
		now := g.now()
		g.Cache.Set(key, CacheEntry{
			Response:             cloneOriginResponse(final),
			Path:                 request.URI,
			StoredAt:             now,
			ExpiresAt:            now.Add(ttl),
			StaleWhileRevalidate: control.StaleWhileRevalidate,
			StaleIfError:         control.StaleIfError,
		})
	}()
}

// applyCustomErrorResponse replaces an origin error with the configured custom
// error page, or keeps the origin response when the page itself is unavailable.
// It returns the response and the error-caching TTL that applies to it.
func (g *Gateway) applyCustomErrorResponse(
	ctx context.Context,
	origin Origin,
	originRequest OriginRequest,
	response OriginResponse,
) (OriginResponse, int) {
	custom, ok := g.Distribution.CustomErrorResponseFor(response.StatusCode)
	if !ok {
		return response, 0
	}
	ttl := custom.ErrorCachingMinTTL
	if ttl <= 0 {
		ttl = int(defaultErrorCachingTTL / time.Second)
	}
	if custom.ResponsePagePath == "" {
		final := cloneOriginResponse(response)
		if custom.ResponseCode != 0 {
			final.StatusCode = custom.ResponseCode
		}
		return final, ttl
	}
	pageRequest := originRequest
	pageRequest.Method = http.MethodGet
	pageRequest.URI = custom.ResponsePagePath
	pageRequest.Body = nil
	pageRequest.Range = ""
	pageRequest.Header = http.Header{}
	if originRequest.Header != nil {
		for name, values := range originRequest.Header {
			if isConditionalHeader(name) {
				continue
			}
			pageRequest.Header[name] = append([]string(nil), values...)
		}
	}
	page, err := origin.Fetch(ctx, pageRequest)
	if err != nil || page.StatusCode < 200 || page.StatusCode >= 300 {
		// "CloudFront returns to the viewer the status code that CloudFront
		// received from the origin that contains the custom error pages."
		// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html
		return response, ttl
	}
	page.StatusCode = custom.ResponseCode
	if page.StatusCode == 0 {
		page.StatusCode = http.StatusOK
	}
	return page, ttl
}

// notModifiedFromCache answers a viewer conditional request from the cached
// validators.
func notModifiedFromCache(header http.Header, response OriginResponse) (OriginResponse, bool) {
	ifNoneMatch := strings.TrimSpace(header.Get("If-None-Match"))
	if ifNoneMatch != "" {
		if matchETag(ifNoneMatch, originHeaderValue(response.Header, "ETag")) {
			return notModifiedResponse(response), true
		}
		return OriginResponse{}, false
	}
	ifModifiedSince := strings.TrimSpace(header.Get("If-Modified-Since"))
	if ifModifiedSince == "" {
		return OriginResponse{}, false
	}
	since, err := http.ParseTime(ifModifiedSince)
	if err != nil {
		return OriginResponse{}, false
	}
	modified, err := http.ParseTime(originHeaderValue(response.Header, "Last-Modified"))
	if err != nil {
		return OriginResponse{}, false
	}
	if !modified.After(since) {
		return notModifiedResponse(response), true
	}
	return OriginResponse{}, false
}

func matchETag(ifNoneMatch, etag string) bool {
	if etag == "" {
		return false
	}
	for _, candidate := range strings.Split(ifNoneMatch, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == etag {
			return true
		}
	}
	return false
}

func notModifiedResponse(response OriginResponse) OriginResponse {
	notModified := OriginResponse{StatusCode: http.StatusNotModified, Header: http.Header{}}
	for _, name := range []string{"ETag", "Last-Modified", "Vary"} {
		if value := originHeaderValue(response.Header, name); value != "" {
			notModified.Header.Set(name, value)
		}
	}
	return notModified
}

func isConditionalHeader(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	case "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since":
		return true
	default:
		return false
	}
}

// responseTTL chooses the cache duration: the configured error-caching TTL for
// a custom error response, CloudFront's default 10 seconds for any other 4xx or
// 5xx, and the cache policy's TTL rules for a normal response.
func (g *Gateway) responseTTL(response OriginResponse, behavior *Behavior, errorCachingTTL int) (time.Duration, CacheControl) {
	if errorCachingTTL > 0 {
		return time.Duration(errorCachingTTL) * time.Second, CacheControl{}
	}
	if response.StatusCode >= 400 {
		return defaultErrorCachingTTL, CacheControl{}
	}
	policy := policyCache(behavior)
	if policy == nil {
		return 0, CacheControl{}
	}
	return policy.OriginTTL(response, g.now())
}

func cloneOriginResponse(response OriginResponse) OriginResponse {
	cloned := response
	if response.Header != nil {
		cloned.Header = response.Header.Clone()
	}
	if response.Body != nil {
		cloned.Body = append([]byte(nil), response.Body...)
	}
	return cloned
}

// setCacheHeaders stamps the x-cache value and, for a hit, the age in seconds.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
func setCacheHeaders(response *OriginResponse, value string, age int) {
	if response.Header == nil {
		response.Header = http.Header{}
	}
	response.Header.Set("x-cache", value)
	if value == cacheHitHeader && age >= 0 {
		response.Header.Set("age", strconv.Itoa(age))
	}
}
