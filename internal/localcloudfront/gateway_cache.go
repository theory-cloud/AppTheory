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
	g.finishResponse(writer, request, behavior, state, requestID, domainName, response, cacheHitHeader, age, true)
	if note != "" {
		g.logf("cloudfront %s %s %s -> %d (cached: %s, age %ds)",
			g.Distribution.LogicalID, request.Method, request.URL.EscapedPath(), entry.Response.StatusCode, note, age)
	}
}

// refreshInBackground re-fetches a stale entry while the stale response is
// served, which is what stale-while-revalidate asks for. A revalidation is a
// request CloudFront forwards to the origin, so it runs the behavior's
// origin-request and origin-response functions exactly like a miss.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-cloudfront-trigger-events.html
func (g *Gateway) refreshInBackground(
	state *requestState,
	origin Origin,
	originConfig *DistributionOrigin,
	originRequest OriginRequest,
	behavior *Behavior,
	key, requestID, domainName string,
) {
	if origin == nil {
		return
	}
	request := originRequest
	storedPath := state.URI
	storedQuery := CacheKeyQuery(state.RawQuery, policyCache(behavior))
	viewer := &requestState{
		Method:        http.MethodGet,
		URI:           state.URI,
		RawQuery:      state.RawQuery,
		Host:          state.Host,
		Header:        state.Header.Clone(),
		ViewerIP:      state.ViewerIP,
		ViewerAddress: state.ViewerAddress,
		Proto:         state.Proto,
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		generated, ok := g.revalidateOriginRequest(ctx, &request, &origin, &originConfig, behavior, requestID, domainName)
		if !ok {
			return
		}
		if generated != nil {
			g.storeRefreshed(ctx, viewer, request, behavior, key, storedPath, storedQuery, *generated, true)
			return
		}
		fetched, err := origin.Fetch(ctx, request)
		if err != nil {
			return
		}
		if !g.revalidateOriginResponse(ctx, &fetched, request, originConfig, behavior, requestID, domainName) {
			return
		}
		g.storeRefreshed(ctx, viewer, request, behavior, key, storedPath, storedQuery, fetched, false)
	}()
}

// revalidateOriginRequest runs the origin-request function for a revalidation.
// It reports a generated response when the function produced one, and false when
// the refresh must be abandoned (a function error, an unknown origin, or no
// local implementation).
func (g *Gateway) revalidateOriginRequest(
	ctx context.Context,
	request *OriginRequest,
	origin *Origin,
	originConfig **DistributionOrigin,
	behavior *Behavior,
	requestID, domainName string,
) (*OriginResponse, bool) {
	association := behavior.EdgeLambdas[edgeOriginRequest]
	if association == nil {
		return nil, true
	}
	event := g.edgeOriginEvent(association, *request, *originConfig, requestID, domainName, nil)
	outcome, err := g.invokeEdge(ctx, association, event)
	if err != nil {
		return nil, false
	}
	if outcome.Response != nil {
		generated, responseErr := g.edgeGeneratedResponse(association, outcome.Response, nil)
		if responseErr != nil {
			return nil, false
		}
		return &generated, true
	}
	if outcome.Request == nil {
		return nil, true
	}
	applyEdgeOriginRequest(request, outcome.Request)
	if outcome.Request.Origin == nil {
		return nil, true
	}
	resolved, found := g.resolveEdgeOrigin(outcome.Request.Origin)
	if !found {
		return nil, false
	}
	*originConfig, _ = g.Distribution.Origin(resolved)
	*origin = g.Origins[resolved]
	if *origin == nil {
		return nil, false
	}
	request.OriginID = resolved
	if *originConfig != nil {
		request.OriginPath = (*originConfig).OriginPath
	}
	return nil, true
}

// revalidateOriginResponse runs the origin-response function for a
// revalidation. It reports false when the refresh must be abandoned.
func (g *Gateway) revalidateOriginResponse(
	ctx context.Context,
	response *OriginResponse,
	request OriginRequest,
	originConfig *DistributionOrigin,
	behavior *Behavior,
	requestID, domainName string,
) bool {
	association := behavior.EdgeLambdas[edgeOriginResponse]
	if association == nil {
		return true
	}
	event := g.edgeOriginEvent(association, request, originConfig, requestID, domainName, response)
	outcome, err := g.invokeEdge(ctx, association, event)
	if err != nil {
		return false
	}
	if outcome.Response == nil {
		return true
	}
	replaced, responseErr := g.edgeGeneratedResponse(association, outcome.Response, response.Body)
	if responseErr != nil {
		return false
	}
	*response = replaced
	return true
}

// storeRefreshed applies the custom error rule and the TTL to a revalidated
// object and stores it under the existing cache key.
func (g *Gateway) storeRefreshed(
	ctx context.Context,
	viewer *requestState,
	originRequest OriginRequest,
	behavior *Behavior,
	key, storedPath, storedQuery string,
	response OriginResponse,
	generated bool,
) {
	final := response
	errorCaching := errorCachingDecision{}
	if !generated {
		final, errorCaching = g.applyCustomErrorResponse(ctx, viewer, originRequest, behavior, response)
	}
	ttl, control := g.responseTTL(final, behavior, errorCaching)
	if ttl <= 0 {
		return
	}
	now := g.now()
	g.Cache.Set(key, CacheEntry{
		Response:             cloneOriginResponse(final),
		Path:                 storedPath,
		Query:                storedQuery,
		StoredAt:             now,
		ExpiresAt:            now.Add(ttl),
		StaleWhileRevalidate: control.StaleWhileRevalidate,
		StaleIfError:         control.StaleIfError,
	})
}

// errorCachingDecision is the error-caching rule that applies to one origin
// response. status is the status the rule is keyed to: the origin's ErrorCode
// for a configured custom error response, otherwise the origin response's own
// status. control and expiry come from the origin response that generated the
// error, as the page states.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
type errorCachingDecision struct {
	applies bool
	status  int
	minimum time.Duration
	control CacheControl
	expires time.Time
	// behaviorTTL is set when a configured cache behavior matches the custom
	// error page path: "If you also configured a cache behavior for the same
	// custom error page, CloudFront uses the cache behavior TTL instead."
	behaviorTTL bool
	// fetchBehavior is the cache behavior the response was fetched through:
	// the request's behavior for a status rewrite or an unavailable page, and
	// the page's behavior once the page is served. Its Maximum TTL caps the
	// error caching duration: "The Cache-Control: max-age and
	// Cache-Control: s-maxage values cannot be greater than the Maximum TTL
	// value set for the cache behavior for which the error page is being
	// fetched."
	//
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
	fetchBehavior *Behavior
}

// applyCustomErrorResponse replaces an origin error with the configured custom
// error page, or keeps the origin response when no page is configured. The page
// is resolved through the distribution's cache behaviors: "CloudFront finds the
// first cache behavior in your distribution that has a path pattern that
// matches the path of the custom error page" and "The CloudFront edge location
// sends a request for the custom error page to the origin that is specified in
// the cache behavior." When the page is unavailable, "CloudFront returns to the
// viewer the status code that CloudFront received from the origin that contains
// the custom error pages."
//
// The fetching behavior starts as the request's behavior and becomes the page's
// behavior once the page is served, so the Maximum TTL cap applies to every
// error caching path.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html
func (g *Gateway) applyCustomErrorResponse(
	ctx context.Context,
	viewer *requestState,
	originRequest OriginRequest,
	behavior *Behavior,
	response OriginResponse,
) (OriginResponse, errorCachingDecision) {
	custom, ok := g.Distribution.CustomErrorResponseFor(response.StatusCode)
	if !ok {
		return response, errorCachingDecision{}
	}
	decision := errorCachingDecision{
		applies:       true,
		status:        custom.ErrorCode,
		minimum:       g.errorCachingMinimum(custom, originRequest.OriginID),
		control:       ParseCacheControl(originHeaderValues(response.Header, "Cache-Control")),
		fetchBehavior: behavior,
	}
	if expires, ok := parseHTTPDate(originHeaderValue(response.Header, "Expires")); ok {
		decision.expires = expires
	}
	if custom.ResponsePagePath == "" {
		final := cloneOriginResponse(response)
		if custom.ResponseCode != 0 {
			final.StatusCode = custom.ResponseCode
		}
		return final, decision
	}
	pageBehavior := g.Distribution.BehaviorForURI(custom.ResponsePagePath)
	if pageBehavior == nil {
		return response, decision
	}
	pageOrigin, pageOriginConfig, _ := g.originForTarget(pageBehavior.TargetOriginID)
	if pageOrigin == nil {
		return response, decision
	}
	pageState := &requestState{
		Method:        http.MethodGet,
		URI:           custom.ResponsePagePath,
		Host:          viewer.Host,
		Header:        errorPageHeaders(viewer.Header),
		ViewerIP:      viewer.ViewerIP,
		ViewerAddress: viewer.ViewerAddress,
		Proto:         viewer.Proto,
	}
	pageRequest := g.originRequest(pageState, pageBehavior, pageOriginConfig, pageBehavior.TargetOriginID, originRequest.RequestID)
	page, err := pageOrigin.Fetch(ctx, pageRequest)
	if err != nil {
		return response, decision
	}
	if page.StatusCode < 200 || page.StatusCode >= 300 {
		// The pages origin's status is now the response's status; it is what
		// CloudFront returns to the viewer when the page is unavailable.
		decision.status = page.StatusCode
		decision.control = ParseCacheControl(originHeaderValues(page.Header, "Cache-Control"))
		decision.expires = time.Time{}
		if expires, ok := parseHTTPDate(originHeaderValue(page.Header, "Expires")); ok {
			decision.expires = expires
		}
		return cloneOriginResponse(page), decision
	}
	// The served page is fetched through pageBehavior, so its Maximum TTL caps
	// the error caching duration even when only the default behavior matched.
	decision.fetchBehavior = pageBehavior
	// "If you also configured a cache behavior for the same custom error page,
	// CloudFront uses the cache behavior TTL instead." Only an explicit cache
	// behavior counts; the default behavior alone leaves the error rule in
	// place.
	if _, explicit := g.Distribution.ExplicitBehaviorForURI(custom.ResponsePagePath); explicit {
		decision.behaviorTTL = true
	}
	page.StatusCode = custom.ResponseCode
	if page.StatusCode == 0 {
		page.StatusCode = http.StatusOK
	}
	return page, decision
}

// errorPageHeaders builds the header set for the custom error page request: the
// viewer's headers without the conditional headers, which belong to the object
// that failed.
func errorPageHeaders(viewer http.Header) http.Header {
	header := http.Header{}
	for name, values := range viewer {
		if isConditionalHeader(name) {
			continue
		}
		header[name] = append([]string(nil), values...)
	}
	return header
}

// errorCachingMinimum is the configured ErrorCachingMinTTL, or the documented
// default. An explicit 0 disables error caching for a custom origin and means
// one second for an S3 origin: "If you have caching enabled for an S3 bucket
// origin, and you configure an error caching minimum TTL of 0 seconds ... you
// will still see an error caching minimum TTL of 1 second for S3 origin
// errors ... This doesn't apply to other types of origins."
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
func (g *Gateway) errorCachingMinimum(custom CustomErrorResponse, originID string) time.Duration {
	if custom.ErrorCachingMinTTL == nil {
		return defaultErrorCachingTTL
	}
	seconds := *custom.ErrorCachingMinTTL
	if seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if origin, ok := g.Distribution.Origin(originID); ok && origin.Kind == OriginS3 {
		return time.Second
	}
	return 0
}

// staleErrorWindow is the error caching minimum TTL that applies when the
// origin answers an expired object with a 5xx status: a custom error response
// for that status names one, otherwise the 10 second default applies.
func (g *Gateway) staleErrorWindow(originID string, status int) time.Duration {
	if custom, ok := g.Distribution.CustomErrorResponseFor(status); ok {
		return g.errorCachingMinimum(custom, originID)
	}
	return defaultErrorCachingTTL
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

// responseTTL chooses the cache duration. A custom error page uses its cache
// behavior's TTL when an explicit cache behavior matches the page path;
// otherwise an error response follows the status tables; a normal response uses
// the cache policy's TTL rules.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
func (g *Gateway) responseTTL(response OriginResponse, behavior *Behavior, errorCaching errorCachingDecision) (time.Duration, CacheControl) {
	if errorCaching.applies {
		// "If you're using the CachingDisabled managed cache policy, CloudFront
		// won't cache these status codes or custom error pages." The page's
		// fetching behavior decides, even when the request matched a cacheable
		// explicit behavior.
		if policy := policyCache(errorCaching.fetchBehavior); policy != nil && policy.CachingDisabled {
			return 0, CacheControl{}
		}
		if errorCaching.behaviorTTL && errorCaching.fetchBehavior != nil {
			if policy := policyCache(errorCaching.fetchBehavior); policy != nil {
				return policy.OriginTTL(response, g.now())
			}
			return 0, CacheControl{}
		}
		return g.errorResponseTTL(errorCaching), errorCaching.control
	}
	if response.StatusCode >= 400 {
		control := ParseCacheControl(originHeaderValues(response.Header, "Cache-Control"))
		caching := errorCachingDecision{
			applies: true,
			status:  response.StatusCode,
			minimum: defaultErrorCachingTTL,
			control: control,
		}
		if expires, ok := parseHTTPDate(originHeaderValue(response.Header, "Expires")); ok {
			caching.expires = expires
		}
		return g.errorResponseTTLWithBehavior(caching, behavior), control
	}
	policy := policyCache(behavior)
	if policy == nil {
		return 0, CacheControl{}
	}
	return policy.OriginTTL(response, g.now())
}

// errorResponseTTL applies the error caching tables: CloudFront caches 404,
// 414, 500, 501, 502, 503 and 504 unconditionally; 400, 403, 405, 412 and 415
// "only ... if your origin returns a Cache-Control max-age or Cache-Control
// s-maxage header"; every other status is not cached. The duration is "the
// maximum of" the error caching minimum TTL and the origin's max-age, s-maxage
// or Expires value, and cannot exceed the behavior's Maximum TTL.
func (g *Gateway) errorResponseTTL(errorCaching errorCachingDecision) time.Duration {
	return g.errorResponseTTLWithBehavior(errorCaching, errorCaching.fetchBehavior)
}

func (g *Gateway) errorResponseTTLWithBehavior(errorCaching errorCachingDecision, behavior *Behavior) time.Duration {
	if !errorStatusCacheable(errorCaching.status, errorCaching.control) {
		return 0
	}
	ttl := errorCaching.minimum
	if headerTTL := errorHeaderTTL(errorCaching.control, errorCaching.expires, g.now()); headerTTL > ttl {
		ttl = headerTTL
	}
	if maximum := behaviorMaximumTTL(behavior); maximum > 0 && ttl > maximum {
		ttl = maximum
	}
	if ttl < 0 {
		return 0
	}
	return ttl
}

// errorStatusCacheable is the HTTPStatusCodes page's status table.
func errorStatusCacheable(status int, control CacheControl) bool {
	switch status {
	case 404, 414, 500, 501, 502, 503, 504:
		// "If the origin adds a Cache-Control: no-store, no-cache, or private
		// directive for error codes 404, 410, 414, or 501, CloudFront does not
		// cache the error response."
		// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html
		if (status == 404 || status == 410 || status == 414 || status == 501) &&
			(control.NoCache || control.NoStore || control.Private) {
			return false
		}
		return true
	case 400, 403, 405, 412, 415:
		return control.MaxAge != nil || control.SMaxAge != nil
	default:
		return false
	}
}

// errorHeaderTTL is the greatest of the origin's s-maxage, max-age and Expires
// values; zero when the response names none.
func errorHeaderTTL(control CacheControl, expires, now time.Time) time.Duration {
	var ttl time.Duration
	if control.SMaxAge != nil {
		ttl = *control.SMaxAge
	}
	if control.MaxAge != nil && *control.MaxAge > ttl {
		ttl = *control.MaxAge
	}
	if !expires.IsZero() {
		if relative := expires.Sub(now); relative > ttl {
			ttl = relative
		}
	}
	if ttl < 0 {
		return 0
	}
	return ttl
}

// behaviorMaximumTTL is the behavior's Maximum TTL; zero means the documented
// 365 day ceiling in CachePolicy.OriginTTL and no practical cap here.
func behaviorMaximumTTL(behavior *Behavior) time.Duration {
	policy := policyCache(behavior)
	if policy == nil || policy.MaxTTL <= 0 {
		return 0
	}
	return time.Duration(policy.MaxTTL) * time.Second
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
