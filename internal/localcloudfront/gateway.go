package localcloudfront

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// maxGatewayBody is the request body bound. API Gateway and CloudFront both
// bound viewer bodies; a larger body is refused instead of buffered.
const maxGatewayBody = 10 << 20

// Gateway serves one CloudFront distribution's edge path locally. It selects
// the cache behavior, runs the viewer-request and viewer-response functions,
// applies the origin request and response headers policies, and hands origin
// requests to the Origin implementations.
type Gateway struct {
	Distribution *Distribution
	Topology     *Topology
	Origins      map[string]Origin
	Executor     *Executor
	Now          func() time.Time
	RequestID    func() string
	Logf         func(format string, args ...any)
	MaxBody      int64
	// Cache stores origin responses for this distribution.
	Cache *Cache
	// EdgeInvoker invokes Lambda@Edge function versions through the runner's
	// real function path.
	EdgeInvoker EdgeInvoker
	// ViewerCountry is the run's resolved ISO 3166-1 alpha-2 viewer country.
	// An empty value is an undetermined location.
	ViewerCountry string
	// stats counts hits and misses per behavior path pattern.
	statsMu sync.Mutex
	stats   map[string]*BehaviorStats
}

// BehaviorStats is one behavior's cache hit and miss counts.
type BehaviorStats struct {
	Hits   int `json:"hits"`
	Misses int `json:"misses"`
}

// Stats returns a copy of the gateway's per-behavior hit and miss counts.
func (g *Gateway) Stats() map[string]BehaviorStats {
	g.statsMu.Lock()
	defer g.statsMu.Unlock()
	out := make(map[string]BehaviorStats, len(g.stats))
	for pattern, stats := range g.stats {
		out[pattern] = *stats
	}
	return out
}

func (g *Gateway) recordStats(pattern string, hit bool) {
	g.statsMu.Lock()
	defer g.statsMu.Unlock()
	if g.stats == nil {
		g.stats = map[string]*BehaviorStats{}
	}
	stats, ok := g.stats[pattern]
	if !ok {
		stats = &BehaviorStats{}
		g.stats[pattern] = stats
	}
	if hit {
		stats.Hits++
		return
	}
	stats.Misses++
}

// NewGateway builds a gateway. A nil executor uses the default Node executor;
// a nil origin map leaves every origin without a local implementation, which the
// gateway reports as a named 503.
func NewGateway(
	distribution *Distribution,
	topology *Topology,
	origins map[string]Origin,
	executor *Executor,
	logf func(string, ...any),
) *Gateway {
	if executor == nil {
		executor = NewExecutor()
	}
	if origins == nil {
		origins = map[string]Origin{}
	}
	return &Gateway{
		Distribution: distribution,
		Topology:     topology,
		Origins:      origins,
		Executor:     executor,
		Now:          time.Now,
		RequestID:    newGatewayRequestID,
		Logf:         logf,
		MaxBody:      maxGatewayBody,
		Cache:        NewCache(),
		stats:        map[string]*BehaviorStats{},
	}
}

// ServeHTTP runs one viewer request through the distribution's edge path.
//
//nolint:gocognit,gocyclo // the phase order is documented and pinned by the docs-order test
func (g *Gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if g.Distribution == nil {
		writeErrorResponse(writer, request, http.StatusInternalServerError, "the gateway has no distribution")
		return
	}
	if !g.Distribution.Servable() {
		writeErrorResponse(writer, request, http.StatusServiceUnavailable,
			"distribution "+g.Distribution.LogicalID+" is refused: "+strings.Join(g.Distribution.Refusals, "; "))
		return
	}
	requestID := g.newRequestID()
	body, err := readGatewayBody(request, g.MaxBody)
	if err != nil {
		writeErrorResponse(writer, request, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	state := newRequestState(request, body)
	originalURI := state.URI
	behavior := g.Distribution.BehaviorForURI(originalURI)
	if behavior == nil {
		g.respondError(writer, request, nil, state.Header, http.StatusServiceUnavailable,
			"the distribution has no cache behavior for "+originalURI)
		return
	}
	domainName := request.Host
	if domainName == "" {
		domainName = strings.ToLower(g.Distribution.LogicalID) + ".cloudfront.local"
	}

	// Geo restriction runs before any viewer function runs. "If CloudFront
	// can't determine a user's location, CloudFront serves the content."
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html
	if g.Distribution.GeoRestriction.Blocks(g.ViewerCountry) {
		g.respondViewerBlock(writer, request, behavior, state, requestID, domainName, http.StatusForbidden,
			fmt.Sprintf("CloudFront geo restriction blocks viewer country %s", g.ViewerCountry))
		return
	}
	// A behavior with trusted key groups requires a valid signed URL or signed
	// cookie; OPTIONS is exempt.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html
	if signedErr := g.checkSignedAccess(state, behavior, g.now()); signedErr != nil {
		g.respondViewerBlock(writer, request, behavior, state, requestID, domainName, http.StatusForbidden, signedErr.Error())
		return
	}

	// AWS documents the viewer-request trigger and the 403 (Invalid method)
	// response separately, but not their relative order. The local gateway runs
	// the function first by choice, so a function can answer a request whose
	// method the behavior does not allow; see docs/examples/local-runner.md.
	//
	// A behavior cannot combine a CloudFront Function and a Lambda@Edge
	// function in a viewer event; topology validation refuses that combination.
	if behavior.ViewerRequestFunction != "" {
		function, ok := g.function(behavior.ViewerRequestFunction)
		if !ok {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
				fmt.Sprintf("CloudFront Function %q is referenced but cannot run locally", behavior.ViewerRequestFunction))
			return
		}
		event := buildViewerRequestEvent(state, g.Distribution, requestID, domainName)
		result, executeErr := g.Executor.Execute(request.Context(), function, event)
		if executeErr != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-request", function, executeErr)
			return
		}
		if result.Kind == ResultResponse {
			response, responseErr := responseFromEventResponse(result.Response, nil)
			if responseErr != nil {
				g.functionFailure(writer, request, behavior, state.Header, "viewer-request", function, responseErr)
				return
			}
			applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &response)
			g.log(request, behavior, response.StatusCode, "viewer-request short-circuit")
			g.write(writer, request, response)
			return
		}
		applyFunctionRequest(state, result.Request)
	}

	// Lambda@Edge viewer-request. A generated response is not cached and the
	// viewer-response functions do not run for it.
	if association := behavior.EdgeLambdas[edgeViewerRequest]; association != nil {
		event := g.edgeEvent(association, state, requestID, domainName, nil)
		outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
		if edgeErr != nil {
			g.edgeFailure(writer, request, behavior, state.Header, "viewer-request", edgeErr)
			return
		}
		if outcome.Response != nil {
			response, responseErr := g.edgeGeneratedResponse(association, outcome.Response, nil)
			if responseErr != nil {
				g.edgeFailure(writer, request, behavior, state.Header, "viewer-request", responseErr)
				return
			}
			applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &response)
			g.log(request, behavior, response.StatusCode, "Lambda@Edge viewer-request short-circuit")
			g.write(writer, request, response)
			return
		}
		applyEdgeRequest(state, outcome.Request)
	}

	if !methodAllowed(behavior.AllowedMethods, state.Method) {
		g.respondError(writer, request, behavior, state.Header, http.StatusForbidden,
			fmt.Sprintf("method %s is not allowed by cache behavior %q (AllowedMethods: %s)",
				state.Method, behavior.PathPattern, strings.Join(behavior.AllowedMethods, ", ")))
		return
	}
	if state.URI == "/" && g.Distribution.DefaultRootObject != "" {
		state.URI = "/" + g.Distribution.DefaultRootObject
	}
	// CloudFront adds its location headers after the viewer request event and
	// only when a cache or origin request policy forwards them.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html
	g.addViewerCountry(state, behavior)

	targetID := behavior.TargetOriginID
	originImplementation, origin, _ := g.originForTarget(targetID)
	if originImplementation == nil {
		g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
			(&OriginUnavailableError{OriginID: targetID, Reason: "the assembly declares it but the runner registered no implementation"}).Error())
		return
	}
	originRequest := g.originRequest(state, behavior, origin, targetID, requestID)
	now := g.now()
	// A viewer Range request bypasses the local cache: CloudFront can serve a
	// range from the cached object, which this gateway does not slice. The
	// deviation is documented in the reference.
	cacheable := g.cacheable(behavior, state.Method) && state.Header.Get("Range") == ""
	cacheKey := ""
	var staleEntry CacheEntry
	hasStaleEntry := false
	if cacheable {
		cacheKey = CacheKey(domainName, state.Method, state.URI, state.RawQuery, state.Header, policyCache(behavior))
		entry, ok := g.Cache.Get(cacheKey)
		if ok && entry.Fresh(now) {
			g.recordStats(behavior.PathPattern, true)
			g.respondFromCache(writer, request, behavior, state, requestID, domainName, entry, now, "")
			return
		}
		if ok && entry.ServeStaleWhileRevalidate(now, behaviorMaximumTTL(behavior)) {
			g.recordStats(behavior.PathPattern, true)
			g.refreshInBackground(state, originImplementation, origin, originRequest, behavior, cacheKey, requestID, domainName)
			g.respondFromCache(writer, request, behavior, state, requestID, domainName, entry, now, "served stale while revalidating")
			return
		}
		if ok {
			staleEntry, hasStaleEntry = entry, true
		}
	}
	g.recordStats(behavior.PathPattern, false)

	// Lambda@Edge origin-request runs only when CloudFront forwards a request
	// to the origin. A generated response is cached under the normal rules and
	// later served from the cache without running the function. Its event is
	// built from the policy-filtered origin request, and a returned object is
	// applied to that request, never to the viewer state.
	var originResponse OriginResponse
	generatedByOriginRequest := false
	if association := behavior.EdgeLambdas[edgeOriginRequest]; association != nil {
		event := g.edgeOriginEvent(association, originRequest, origin, requestID, domainName, nil)
		outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
		if edgeErr != nil {
			g.edgeFailure(writer, request, behavior, state.Header, "origin-request", edgeErr)
			return
		}
		if outcome.Response != nil {
			generated, responseErr := g.edgeGeneratedResponse(association, outcome.Response, nil)
			if responseErr != nil {
				g.edgeFailure(writer, request, behavior, state.Header, "origin-request", responseErr)
				return
			}
			originResponse = generated
			generatedByOriginRequest = true
		} else if outcome.Request != nil {
			// The returned request is exactly what CloudFront sends to the
			// origin: the origin request policy was already applied before the
			// function ran, so it is not filtered again.
			hostChanged := edgeRequestHost(outcome.Request) != originRequest.Host
			applyEdgeOriginRequest(&originRequest, outcome.Request)
			if outcome.Request.Origin != nil {
				resolved, ok := g.resolveEdgeOrigin(outcome.Request.Origin)
				if !ok {
					g.edgeFailure(writer, request, behavior, state.Header, "origin-request", &EdgeValidationError{
						Function: association.Version,
						Reason: fmt.Sprintf("origin %q is not an origin of the distribution; the local gateway never reaches the internet",
							edgeOriginDomain(outcome.Request.Origin)),
					})
					return
				}
				targetID = resolved
				originImplementation, origin, _ = g.originForTarget(targetID)
				if originImplementation == nil {
					g.edgeFailure(writer, request, behavior, state.Header, "origin-request", &EdgeValidationError{
						Function: association.Version,
						Reason:   fmt.Sprintf("origin %q has no local implementation", edgeOriginDomain(outcome.Request.Origin)),
					})
					return
				}
				originRequest.OriginID = targetID
				if origin != nil {
					originRequest.OriginPath = origin.OriginPath
					if !hostChanged {
						originRequest.Host = origin.DomainName
					}
				}
			}
		}
	}

	originResponseFunctionDone := false
	if !generatedByOriginRequest {
		fle, fleErr := g.applyFieldLevelEncryption(state, behavior, &originRequest)
		if fleErr != nil {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable, fleErr.Error())
			return
		}
		if fle.Blocked {
			g.respondViewerBlock(writer, request, behavior, state, requestID, domainName, fle.Status, fle.Reason)
			return
		}
		var fetched OriginResponse
		streamed := false
		if streamOrigin, ok := originImplementation.(StreamOrigin); ok {
			outcome, streamErr := g.serveStreamingOrigin(writer, request, behavior, state, requestID, domainName,
				originRequest, origin, streamOrigin, cacheable, cacheKey, now)
			switch {
			case errors.Is(streamErr, ErrStreamUnavailable):
				// The origin cannot stream this request (a --rie invoker, or a
				// transport without incremental forwarding). Serve it through
				// the buffered Fetch path; the Function URL listener does the
				// same fallback on the same condition.
			case streamErr != nil:
				if hasStaleEntry && staleEntry.ServeStaleIfError(now, behaviorMaximumTTL(behavior)) {
					g.respondFromCache(writer, request, behavior, state, requestID, domainName, staleEntry, now, "served stale after the origin failed")
					return
				}
				var unavailable *OriginUnavailableError
				if errors.As(streamErr, &unavailable) || errors.Is(streamErr, ErrOriginUnavailable) {
					g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable, streamErr.Error())
					return
				}
				g.respondError(writer, request, behavior, state.Header, http.StatusBadGateway,
					fmt.Sprintf("origin %q failed: %v", targetID, streamErr))
				return
			default:
				if outcome.Handled {
					return
				}
				fetched = outcome.Buffered
				// The streaming path already ran the origin-response function with
				// the status and headers it saw when the stream opened.
				originResponseFunctionDone = true
				streamed = true
			}
		}
		if !streamed {
			var originErr error
			fetched, originErr = originImplementation.Fetch(request.Context(), originRequest)
			if originErr != nil {
				if hasStaleEntry && staleEntry.ServeStaleIfError(now, behaviorMaximumTTL(behavior)) {
					g.respondFromCache(writer, request, behavior, state, requestID, domainName, staleEntry, now, "served stale after the origin failed")
					return
				}
				var unavailable *OriginUnavailableError
				if errors.As(originErr, &unavailable) || errors.Is(originErr, ErrOriginUnavailable) {
					g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable, originErr.Error())
					return
				}
				g.respondError(writer, request, behavior, state.Header, http.StatusBadGateway,
					fmt.Sprintf("origin %q failed: %v", targetID, originErr))
				return
			}
		}
		// Lambda@Edge origin-response runs after CloudFront receives a response
		// from the origin and before it caches the object, "even if an error is
		// returned from the origin". The function does not see the origin body;
		// it may replace it.
		if association := behavior.EdgeLambdas[edgeOriginResponse]; association != nil && !originResponseFunctionDone {
			event := g.edgeOriginEvent(association, originRequest, origin, requestID, domainName, &fetched)
			outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
			if edgeErr != nil {
				g.edgeFailure(writer, request, behavior, state.Header, "origin-response", edgeErr)
				return
			}
			if outcome.Response != nil {
				replaced, responseErr := g.edgeGeneratedResponse(association, outcome.Response, fetched.Body)
				if responseErr != nil {
					g.edgeFailure(writer, request, behavior, state.Header, "origin-response", responseErr)
					return
				}
				fetched = replaced
			}
		}
		// An origin 5xx response for an expired object is treated like an
		// unreachable origin: "If your origin returns a 5xx status code, CloudFront
		// serves the object even though it has expired. For the duration of the
		// error caching minimum TTL, CloudFront continues to respond to viewer
		// requests by serving the object from the edge cache." A 4xx response is
		// returned to the viewer instead. The stale-if-error directive extends the
		// window, and the behavior's Maximum TTL caps it.
		// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
		if hasStaleEntry && fetched.StatusCode >= 500 && fetched.StatusCode < 600 {
			window := g.staleErrorWindow(targetID, fetched.StatusCode)
			if staleEntry.ServeStaleForErrorResponse(now, window, behaviorMaximumTTL(behavior)) {
				g.respondFromCache(writer, request, behavior, state, requestID, domainName, staleEntry, now,
					fmt.Sprintf("served stale after the origin returned %d", fetched.StatusCode))
				return
			}
		}
		originResponse = fetched
	}

	response := originResponse
	errorCaching := errorCachingDecision{}
	customErrorPage := false
	if !generatedByOriginRequest {
		response, errorCaching = g.applyCustomErrorResponse(request.Context(), state, originRequest, behavior, originResponse)
		customErrorPage = errorCaching.applies && g.responseHasCustomPage(originResponse, response)
	}
	// GET and HEAD share one key, but a HEAD response has no body to serve a
	// later GET, so it is never stored under that key.
	if cacheable && state.Method != http.MethodHead {
		ttl, control := g.responseTTL(response, behavior, errorCaching)
		if ttl > 0 {
			g.Cache.Set(cacheKey, CacheEntry{
				Response:             cloneOriginResponse(response),
				Path:                 state.URI,
				Query:                CacheKeyQuery(state.RawQuery, policyCache(behavior)),
				StoredAt:             now,
				ExpiresAt:            now.Add(ttl),
				StaleWhileRevalidate: control.StaleWhileRevalidate,
				StaleIfError:         control.StaleIfError,
			})
		}
	}

	viewerResponseAllowed := !customErrorPage
	g.finishResponse(writer, request, behavior, state, requestID, domainName, response, cacheMissHeader, 0, viewerResponseAllowed)
}

// responseHasCustomPage reports whether a custom error response replaced the
// origin response with its configured page. The viewer-response function does
// not run "when a custom error page is returned".
func (g *Gateway) responseHasCustomPage(origin, final OriginResponse) bool {
	custom, ok := g.Distribution.CustomErrorResponseFor(origin.StatusCode)
	if !ok || custom.ResponsePagePath == "" {
		return false
	}
	return final.StatusCode != origin.StatusCode || string(final.Body) != string(origin.Body)
}

// addViewerCountry adds CloudFront-Viewer-Country from the run's viewer country
// when a cache policy or origin request policy forwards it.
func (g *Gateway) addViewerCountry(state *requestState, behavior *Behavior) {
	if g.ViewerCountry == "" || behavior == nil {
		return
	}
	if !cachePolicyForwardsHeader(policyCache(behavior), headerCloudFrontViewerCountry) &&
		!originPolicyForwardsHeader(behavior.OriginRequestPolicy, headerCloudFrontViewerCountry) {
		return
	}
	state.Header.Set("CloudFront-Viewer-Country", g.ViewerCountry)
}

func cachePolicyForwardsHeader(policy *CachePolicy, name string) bool {
	if policy == nil {
		return false
	}
	return forwardsHeader(policy.Headers, name)
}

func originPolicyForwardsHeader(policy *Policy, name string) bool {
	if policy == nil || policy.OriginRequest == nil {
		return false
	}
	return forwardsHeader(policy.OriginRequest.Headers, name)
}

// forwardsHeader applies the header forwarding mode to one CloudFront header.
func forwardsHeader(headers HeaderForwarding, name string) bool {
	if headers.CloudFrontHeaders {
		return true
	}
	switch headers.Mode {
	case ForwardAll:
		return true
	case ForwardWhitelist:
		for _, listed := range headers.Names {
			if strings.EqualFold(listed, name) {
				return true
			}
		}
		return false
	case ForwardAllExcept:
		for _, listed := range headers.Names {
			if strings.EqualFold(listed, name) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// respondViewerBlock answers a request the edge refuses before the origin: geo
// restriction and signed URL or cookie failures. The documented 403 is subject
// to the distribution's custom error response and its error caching.
func (g *Gateway) respondViewerBlock(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	state *requestState,
	requestID, domainName string,
	status int,
	detail string,
) {
	response := errorResponse(status, detail)
	originRequest := OriginRequest{
		OriginID:       behavior.TargetOriginID,
		Method:         state.Method,
		URI:            state.URI,
		Query:          state.RawQuery,
		Host:           state.Host,
		Header:         state.Header,
		RequestID:      requestID,
		DistributionID: localDistributionID(g.Distribution),
	}
	final, errorCaching := g.applyCustomErrorResponse(request.Context(), state, originRequest, behavior, response)
	now := g.now()
	customErrorPage := errorCaching.applies && g.responseHasCustomPage(response, final)
	if g.cacheable(behavior, state.Method) && state.Method != http.MethodHead {
		ttl, control := g.responseTTL(final, behavior, errorCaching)
		if ttl > 0 {
			key := CacheKey(domainName, state.Method, state.URI, state.RawQuery, state.Header, policyCache(behavior))
			g.Cache.Set(key, CacheEntry{
				Response:             cloneOriginResponse(final),
				Path:                 state.URI,
				Query:                CacheKeyQuery(state.RawQuery, policyCache(behavior)),
				StoredAt:             now,
				ExpiresAt:            now.Add(ttl),
				StaleWhileRevalidate: control.StaleWhileRevalidate,
				StaleIfError:         control.StaleIfError,
			})
		}
	}
	g.finishResponse(writer, request, behavior, state, requestID, domainName, final, cacheMissHeader, 0, !customErrorPage)
}

// finishResponse runs the viewer-response function and the response headers
// policy on a response (fresh from the origin or from the cache), stamps the
// documented x-cache and age headers and writes it to the viewer.
func (g *Gateway) finishResponse(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	state *requestState,
	requestID, domainName string,
	response OriginResponse,
	cacheValue string,
	age int,
	viewerResponseAllowed bool,
) {
	final := cloneOriginResponse(response)
	if behavior.ViewerResponseFunction != "" {
		function, ok := g.function(behavior.ViewerResponseFunction)
		if !ok {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
				fmt.Sprintf("CloudFront Function %q is referenced but cannot run locally", behavior.ViewerResponseFunction))
			return
		}
		responseEvent := eventResponseFromOrigin(response)
		event := buildViewerResponseEvent(state, g.Distribution, requestID, domainName, responseEvent)
		result, executeErr := g.Executor.Execute(request.Context(), function, event)
		if executeErr != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, executeErr)
			return
		}
		updated, err := responseFromEventResponse(result.Response, response.Body)
		if err != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, err)
			return
		}
		final = updated
	}
	// Lambda@Edge viewer-response. It runs regardless of whether the file came
	// from the cache, but not when the origin returned 400 or higher, not for a
	// custom error page, and not for a response a viewer request function
	// generated.
	if association := behavior.EdgeLambdas[edgeViewerResponse]; association != nil &&
		viewerResponseAllowed && final.StatusCode < 400 {
		event := g.edgeEvent(association, state, requestID, domainName, &final)
		outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
		if edgeErr != nil {
			g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", edgeErr)
			return
		}
		if outcome.Response != nil {
			updated, responseErr := g.edgeGeneratedResponse(association, outcome.Response, final.Body)
			if responseErr != nil {
				g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", responseErr)
				return
			}
			if updated.StatusCode != final.StatusCode {
				g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", &EdgeValidationError{
					Function: association.Version,
					Reason: fmt.Sprintf("a viewer-response function cannot modify the HTTP status code (%d to %d)",
						final.StatusCode, updated.StatusCode),
				})
				return
			}
			final = updated
		}
	}
	if final.Header == nil {
		final.Header = http.Header{}
	} else {
		final.Header = final.Header.Clone()
	}
	applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &final)
	setCacheHeaders(&final, cacheValue, age)
	g.log(request, behavior, final.StatusCode, "")
	g.write(writer, request, final)
}

func (g *Gateway) function(logicalID string) (*Function, bool) {
	if g.Topology == nil {
		return nil, false
	}
	return g.Topology.Function(logicalID)
}

func (g *Gateway) logf(format string, args ...any) {
	if g.Logf != nil {
		g.Logf(format, args...)
	}
}

// edgeFailure answers a Lambda@Edge failure with the documented status: 502 for
// an incorrectly formed response, 503 for an unhandled exception in the
// function code.
// https://repost.aws/knowledge-center/lambda-edge-500-errors
func (g *Gateway) edgeFailure(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	requestHeader http.Header,
	eventType string,
	err error,
) {
	status := http.StatusBadGateway
	var execution *EdgeExecutionError
	if errors.As(err, &execution) {
		status = http.StatusServiceUnavailable
	}
	detail := fmt.Sprintf("Lambda@Edge %s failed: %v. The request was not passed through.", eventType, err)
	g.respondError(writer, request, behavior, requestHeader, status, detail)
}

func (g *Gateway) functionFailure(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	requestHeader http.Header,
	eventType string,
	function *Function,
	err error,
) {
	var functionErr *FunctionError
	if errors.As(err, &functionErr) {
		for _, line := range functionErr.Logs {
			g.logf("cloudfront function %s: %s", function.LogicalID, line)
		}
	}
	detail := fmt.Sprintf("CloudFront Function %q (%s) failed: %v. The request was not passed through.",
		function.LogicalID, eventType, err)
	g.respondError(writer, request, behavior, requestHeader, http.StatusServiceUnavailable, detail)
}

func (g *Gateway) respondError(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	requestHeader http.Header,
	status int,
	detail string,
) {
	response := errorResponse(status, detail)
	if behavior != nil {
		applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, requestHeader, &response)
	}
	g.log(request, behavior, status, detail)
	g.write(writer, request, response)
}

func (g *Gateway) log(request *http.Request, _ *Behavior, status int, note string) {
	if g.Logf == nil {
		return
	}
	suffix := ""
	if note != "" {
		suffix = " (" + note + ")"
	}
	g.logf("cloudfront %s %s %s -> %d%s", g.Distribution.LogicalID, request.Method, request.URL.EscapedPath(), status, suffix)
}

func (g *Gateway) write(writer http.ResponseWriter, request *http.Request, response OriginResponse) {
	if response.StatusCode == 0 {
		response.StatusCode = http.StatusBadGateway
	}
	header := writer.Header()
	for name, values := range response.Header {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	writer.WriteHeader(response.StatusCode)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(response.Body) //nolint:errcheck // response already committed
}

func (g *Gateway) newRequestID() string {
	if g.RequestID != nil {
		return g.RequestID()
	}
	return newGatewayRequestID()
}

func newGatewayRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("local-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes[:])
}

func readGatewayBody(request *http.Request, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = maxGatewayBody
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("request body exceeds the %d byte local limit", limit)
	}
	return body, nil
}

func methodAllowed(methods []string, method string) bool {
	if len(methods) == 0 {
		return method == http.MethodGet || method == http.MethodHead
	}
	for _, allowed := range methods {
		if allowed == method {
			return true
		}
		if method == http.MethodHead && allowed == http.MethodGet {
			return true
		}
	}
	return false
}

func eventResponseFromOrigin(response OriginResponse) *EventResponse {
	headers, cookies := splitResponseHeaders(response.Header)
	return &EventResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.StatusDescription,
		Headers:           headers,
		Cookies:           cookies,
	}
}

func splitResponseHeaders(header http.Header) (map[string]HeaderValue, map[string]CookieValue) {
	headers := map[string]HeaderValue{}
	cookies := map[string]CookieValue{}
	for name, values := range header {
		lower := strings.ToLower(name)
		if lower == "set-cookie" {
			for _, value := range values {
				name, cookieValue, attributes, ok := parseSetCookie(value)
				if !ok {
					continue
				}
				addResponseCookie(cookies, name, cookieValue, attributes)
			}
			continue
		}
		headers[lower] = headerValue(values)
	}
	return headers, cookies
}

func parseSetCookie(value string) (name, cookieValue, attributes string, ok bool) {
	parts := strings.SplitN(value, ";", 2)
	name, cookieValue, found := strings.Cut(parts[0], "=")
	if !found || strings.TrimSpace(name) == "" {
		return "", "", "", false
	}
	if len(parts) == 2 {
		attributes = strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(name), cookieValue, attributes, true
}

func addResponseCookie(cookies map[string]CookieValue, name, value, attributes string) {
	entry := CookieValue{Value: value, Attributes: attributes}
	current, exists := cookies[name]
	if !exists {
		cookies[name] = entry
		return
	}
	if len(current.MultiValue) == 0 {
		current.MultiValue = []CookieValue{{Value: current.Value, Attributes: current.Attributes}}
	}
	current.MultiValue = append(current.MultiValue, entry)
	cookies[name] = current
}

func responseFromEventResponse(response *EventResponse, originBody []byte) (OriginResponse, error) {
	if response == nil {
		return OriginResponse{}, errors.New("viewer-response returned no response object")
	}
	if response.StatusCode < 100 || response.StatusCode > 599 {
		return OriginResponse{}, fmt.Errorf("viewer-response statusCode %d is outside 100..599", response.StatusCode)
	}
	header := http.Header{}
	for name, value := range response.Headers {
		for _, entry := range valuesOf(value) {
			header.Add(name, entry)
		}
	}
	for name, cookie := range response.Cookies {
		entries := []CookieValue{cookie}
		if len(cookie.MultiValue) > 0 {
			entries = cookie.MultiValue
		}
		for _, entry := range entries {
			setCookie := name + "=" + entry.Value
			if entry.Attributes != "" {
				setCookie += "; " + entry.Attributes
			}
			header.Add("Set-Cookie", setCookie)
		}
	}
	body, _, err := decodeResponseBody(response.Body, originBody)
	if err != nil {
		return OriginResponse{}, err
	}
	return OriginResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.StatusDescription,
		Header:            header,
		Body:              body,
	}, nil
}

func errorResponse(status int, detail string) OriginResponse {
	title := fmt.Sprintf("%d %s", status, http.StatusText(status))
	body := fmt.Sprintf("<!DOCTYPE html><html><head><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>",
		html.EscapeString(title), html.EscapeString(title), html.EscapeString(detail))
	return OriginResponse{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:       []byte(body),
	}
}

func writeErrorResponse(writer http.ResponseWriter, request *http.Request, status int, detail string) {
	response := errorResponse(status, detail)
	header := writer.Header()
	for name, values := range response.Header {
		for _, value := range values {
			header.Add(name, value)
		}
	}
	writer.WriteHeader(status)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(response.Body) //nolint:errcheck // response already committed
}
