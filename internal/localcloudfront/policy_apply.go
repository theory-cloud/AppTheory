package localcloudfront

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// forwardingRule is the union of a cache policy and an origin request policy
// for one of headers, cookies or query strings.
type forwardingRule struct {
	All               bool
	Whitelist         map[string]bool
	Except            map[string]bool
	CloudFrontHeaders bool
}

func newForwardingRule() forwardingRule {
	return forwardingRule{Whitelist: map[string]bool{}, Except: map[string]bool{}}
}

func (r *forwardingRule) addHeaders(config HeaderForwarding, caseSensitive bool) {
	switch config.Mode {
	case ForwardAll:
		r.All = true
	case ForwardAllExcept:
		r.All = true
		for _, name := range config.Names {
			r.Except[normalizeName(name, caseSensitive)] = true
		}
	case ForwardWhitelist:
		for _, name := range config.Names {
			r.Whitelist[normalizeName(name, caseSensitive)] = true
		}
	}
	if config.CloudFrontHeaders {
		r.CloudFrontHeaders = true
	}
}

func (r *forwardingRule) addCookies(config CookieForwarding) {
	switch config.Mode {
	case ForwardAll:
		r.All = true
	case ForwardAllExcept:
		r.All = true
		for _, name := range config.Names {
			r.Except[name] = true
		}
	case ForwardWhitelist:
		for _, name := range config.Names {
			r.Whitelist[name] = true
		}
	}
}

func (r *forwardingRule) addQuery(config QueryForwarding) {
	switch config.Mode {
	case ForwardAll:
		r.All = true
	case ForwardAllExcept:
		r.All = true
		for _, name := range config.Names {
			r.Except[name] = true
		}
	case ForwardWhitelist:
		for _, name := range config.Names {
			r.Whitelist[name] = true
		}
	}
}

func normalizeName(name string, caseSensitive bool) string {
	if caseSensitive {
		return name
	}
	return strings.ToLower(name)
}

func (r forwardingRule) selected(name string) bool {
	if r.Except[name] {
		return false
	}
	return r.All || r.Whitelist[name]
}

func combinedHeaderRule(cache *CachePolicy, origin *OriginRequestPolicy) forwardingRule {
	rule := newForwardingRule()
	if cache != nil {
		rule.addHeaders(cache.Headers, false)
	}
	if origin != nil {
		rule.addHeaders(origin.Headers, false)
	}
	return rule
}

func combinedCookieRule(cache *CachePolicy, origin *OriginRequestPolicy) forwardingRule {
	rule := newForwardingRule()
	if cache != nil {
		rule.addCookies(cache.Cookies)
	}
	if origin != nil {
		rule.addCookies(origin.Cookies)
	}
	return rule
}

func combinedQueryRule(cache *CachePolicy, origin *OriginRequestPolicy) forwardingRule {
	rule := newForwardingRule()
	if cache != nil {
		rule.addQuery(cache.QueryStrings)
	}
	if origin != nil {
		rule.addQuery(origin.QueryStrings)
	}
	return rule
}

// originRequest builds the request A5b's origin receives.
func (g *Gateway) originRequest(
	state *requestState,
	behavior *Behavior,
	origin *DistributionOrigin,
	targetID string,
	requestID string,
) OriginRequest {
	cache := policyCache(behavior)
	originPolicy := policyOriginRequest(behavior)
	headerRule := combinedHeaderRule(cache, originPolicy)
	cookieRule := combinedCookieRule(cache, originPolicy)
	queryRule := combinedQueryRule(cache, originPolicy)

	header := http.Header{}
	for name, values := range state.Header {
		lower := strings.ToLower(name)
		if lower == "cookie" || lower == "host" || isHopByHopHeader(lower) || strings.HasPrefix(lower, "cloudfront-") {
			continue
		}
		if !headerRule.selected(lower) {
			continue
		}
		for _, value := range values {
			header.Add(lower, value)
		}
	}
	addCloudFrontHeaders(header, headerRule, state)
	addForwardedCookies(header, cookieRule, state)
	removeHopByHop(header)
	if len(state.Body) > 0 {
		header.Set("Content-Length", strconv.Itoa(len(state.Body)))
	} else {
		header.Del("Content-Length")
	}
	if origin != nil {
		for name, value := range origin.CustomHeaders {
			header.Set(name, value)
		}
	}

	forwardViewerHost := headerRule.selected("host")
	host := ""
	switch {
	case forwardViewerHost && state.Host != "":
		host = state.Host
	case origin != nil:
		host = origin.DomainName
	}
	originPath := ""
	if origin != nil {
		originPath = origin.OriginPath
	}
	return OriginRequest{
		OriginID:   targetID,
		Method:     state.Method,
		URI:        state.URI,
		OriginPath: originPath,
		Query:      filterRawQuery(state.RawQuery, queryRule),
		Host:       host,
		Header:     header,
		Body:       state.Body,
		Range:      state.Header.Get("Range"),
		// CloudFront strips these parameters for an S3 origin only when the
		// behavior uses one of the managed origin request policies listed by
		// AWS; see managedOriginRequestSuppressesS3ResponseOverrides.
		SuppressS3ResponseOverrides: managedOriginRequestSuppressesS3ResponseOverrides(behavior),
		ViewerIP:                    state.ViewerIP,
		RequestID:                   requestID,
		DistributionID:              localDistributionID(g.Distribution),
	}
}

func addCloudFrontHeaders(header http.Header, rule forwardingRule, state *requestState) {
	names := []string{"cloudfront-forwarded-proto", "cloudfront-viewer-address", "cloudfront-viewer-http-version"}
	for _, name := range names {
		if rule.Except[name] {
			continue
		}
		if !rule.CloudFrontHeaders && !rule.Whitelist[name] {
			continue
		}
		switch name {
		case "cloudfront-forwarded-proto":
			header.Set("CloudFront-Forwarded-Proto", "http")
		case "cloudfront-viewer-address":
			header.Set("CloudFront-Viewer-Address", state.ViewerAddress)
		case "cloudfront-viewer-http-version":
			proto := state.Proto
			if proto == "" {
				proto = "HTTP/1.1"
			}
			header.Set("CloudFront-Viewer-Http-Version", proto)
		}
	}
}

func addForwardedCookies(header http.Header, rule forwardingRule, state *requestState) {
	pairs := parseCookiePairs(state.Header.Values("Cookie"))
	var forwarded []string
	for _, pair := range pairs {
		if rule.selected(pair.Name) {
			forwarded = append(forwarded, pair.Name+"="+pair.Value)
		}
	}
	if len(forwarded) > 0 {
		header.Set("Cookie", strings.Join(forwarded, "; "))
	}
}

type rawQuerySegment struct {
	raw  string
	name string
}

func splitRawQuery(raw string) []rawQuerySegment {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "&")
	segments := make([]rawQuerySegment, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		name := part
		if index := strings.IndexByte(part, '='); index >= 0 {
			name = part[:index]
		}
		if decoded, err := urlQueryUnescape(name); err == nil {
			name = decoded
		}
		segments = append(segments, rawQuerySegment{raw: part, name: name})
	}
	return segments
}

func filterRawQuery(raw string, rule forwardingRule) string {
	if raw == "" {
		return ""
	}
	if rule.All && len(rule.Except) == 0 && len(rule.Whitelist) == 0 {
		return raw
	}
	var kept []string
	for _, segment := range splitRawQuery(raw) {
		if rule.selected(segment.name) {
			kept = append(kept, segment.raw)
		}
	}
	return strings.Join(kept, "&")
}

func policyCache(behavior *Behavior) *CachePolicy {
	if behavior == nil || behavior.CachePolicy == nil {
		return nil
	}
	return behavior.CachePolicy.Cache
}

func policyOriginRequest(behavior *Behavior) *OriginRequestPolicy {
	if behavior == nil || behavior.OriginRequestPolicy == nil {
		return nil
	}
	return behavior.OriginRequestPolicy.OriginRequest
}

// s3ResponseOverrideQueryNames are the three query string parameters AWS
// documents as removed from an S3 origin request by the four managed origin
// request policies below.
//
// AWS: "When you use the AllViewer, AllViewerAndCloudFrontHeaders-2022-06,
// AllViewerExceptHostHeader, or Elemental-MediaTailor-PersonalizedManifests
// managed origin request policy with an Amazon S3 origin, CloudFront doesn't
// forward the following query string parameters to the origin:
// response-content-type, response-content-disposition,
// response-content-encoding." This applies only to managed origin request
// policies; a custom policy forwards them as configured.
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html
var s3ResponseOverrideQueryNames = map[string]bool{
	"response-content-type":        true,
	"response-content-disposition": true,
	"response-content-encoding":    true,
}

func managedOriginRequestSuppressesS3ResponseOverrides(behavior *Behavior) bool {
	if behavior == nil || behavior.OriginRequestPolicy == nil || !behavior.OriginRequestPolicy.Managed {
		return false
	}
	switch behavior.OriginRequestPolicy.ID {
	case "216adef6-5c7f-47e4-b989-5492eafa07d3", // AllViewer
		"33f36d7e-f396-46d9-90e0-52428a34d9dc", // AllViewerAndCloudFrontHeaders-2022-06
		"b689b0a8-53d0-40ab-baf2-68738e2966ac", // AllViewerExceptHostHeader
		"775133bc-15f2-49f9-abea-afb2e0bf67d2": // Elemental-MediaTailor-PersonalizedManifests
		return true
	default:
		return false
	}
}

// FilterS3ResponseOverrides removes the three response-content-* parameters
// from a raw query string. Every other parameter is kept in order.
func FilterS3ResponseOverrides(raw string) string {
	if raw == "" {
		return ""
	}
	var kept []string
	for _, segment := range splitRawQuery(raw) {
		if s3ResponseOverrideQueryNames[segment.name] {
			continue
		}
		kept = append(kept, segment.raw)
	}
	return strings.Join(kept, "&")
}

func removeHopByHop(header http.Header) {
	for name := range header {
		if isHopByHopHeader(name) {
			delete(header, name)
		}
	}
}

// applyResponseHeadersPolicy applies a response headers policy after the
// viewer-response function, to the response CloudFront sends to the viewer.
func applyResponseHeadersPolicy(policy *Policy, requestMethod string, requestHeader http.Header, response *OriginResponse) {
	if policy == nil || policy.ResponseHeaders == nil || response == nil {
		return
	}
	if response.Header == nil {
		response.Header = http.Header{}
	}
	for _, name := range policy.ResponseHeaders.Remove {
		response.Header.Del(name)
	}
	applyCORS(policy.ResponseHeaders.CORS, requestMethod, requestHeader, response.Header)
	applySecurityHeaders(policy.ResponseHeaders.Security, response.Header)
	for _, custom := range policy.ResponseHeaders.Custom {
		setUnlessOverridden(response.Header, custom.Name, custom.Value, custom.Override)
	}
}

//nolint:gocyclo // the branches are the CloudFront CORS header sections
func applyCORS(config *CORSConfig, requestMethod string, requestHeader, responseHeader http.Header) {
	if config == nil || len(config.AllowOrigins) == 0 {
		return
	}
	origin := requestHeader.Get("Origin")
	if origin == "" {
		return
	}
	if !config.OriginOverride && hasCORSHeader(responseHeader) {
		return
	}
	allowed := ""
	for _, pattern := range config.AllowOrigins {
		if corsOriginMatches(pattern, origin) {
			allowed = origin
			if pattern == "*" {
				allowed = "*"
			}
			break
		}
	}
	if allowed == "" {
		return
	}
	setUnlessOverridden(responseHeader, "Access-Control-Allow-Origin", allowed, config.OriginOverride)
	if config.AllowCredentials {
		setUnlessOverridden(responseHeader, "Access-Control-Allow-Credentials", "true", config.OriginOverride)
	}
	preflight := requestMethod == http.MethodOptions && requestHeader.Get("Access-Control-Request-Method") != ""
	if preflight {
		if len(config.AllowMethods) > 0 {
			setUnlessOverridden(responseHeader, "Access-Control-Allow-Methods", strings.Join(config.AllowMethods, ", "), config.OriginOverride)
		}
		if len(config.AllowHeaders) > 0 {
			setUnlessOverridden(responseHeader, "Access-Control-Allow-Headers", strings.Join(config.AllowHeaders, ", "), config.OriginOverride)
		}
		if config.MaxAgeSeconds != nil {
			setUnlessOverridden(responseHeader, "Access-Control-Max-Age", strconv.Itoa(*config.MaxAgeSeconds), config.OriginOverride)
		}
	}
	if len(config.ExposeHeaders) > 0 {
		setUnlessOverridden(responseHeader, "Access-Control-Expose-Headers", strings.Join(config.ExposeHeaders, ", "), config.OriginOverride)
	}
}

func hasCORSHeader(header http.Header) bool {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			return true
		}
	}
	return false
}

func corsOriginMatches(pattern, origin string) bool {
	if pattern == "*" {
		return true
	}
	if pattern == origin {
		return true
	}
	if strings.Contains(pattern, "://") {
		return matchGlob(pattern, origin)
	}
	trimmed := origin
	if scheme, rest, found := strings.Cut(origin, "://"); found && (scheme == "http" || scheme == "https") {
		trimmed = rest
	}
	if strings.Contains(pattern, ":") {
		return matchGlob(pattern, trimmed)
	}
	if strings.Contains(trimmed, ":") {
		return false
	}
	return matchGlob(pattern, trimmed)
}

func applySecurityHeaders(config *SecurityHeaders, header http.Header) {
	if config == nil {
		return
	}
	if config.ContentSecurityPolicy != nil {
		setUnlessOverridden(header, "Content-Security-Policy", config.ContentSecurityPolicy.Value, config.ContentSecurityPolicy.Override)
	}
	if config.ContentTypeOptions != nil {
		setUnlessOverridden(header, "X-Content-Type-Options", "nosniff", config.ContentTypeOptions.Override)
	}
	if config.FrameOptions != nil {
		setUnlessOverridden(header, "X-Frame-Options", config.FrameOptions.Value, config.FrameOptions.Override)
	}
	if config.ReferrerPolicy != nil {
		setUnlessOverridden(header, "Referrer-Policy", config.ReferrerPolicy.Value, config.ReferrerPolicy.Override)
	}
	if config.StrictTransportSecurity != nil {
		value := fmt.Sprintf("max-age=%d", config.StrictTransportSecurity.MaxAgeSeconds)
		if config.StrictTransportSecurity.IncludeSubdomains {
			value += "; includeSubDomains"
		}
		if config.StrictTransportSecurity.Preload {
			value += "; preload"
		}
		setUnlessOverridden(header, "Strict-Transport-Security", value, config.StrictTransportSecurity.Override)
	}
	if config.XSSProtection != nil {
		value := "0"
		if config.XSSProtection.Protection {
			value = "1"
		}
		if config.XSSProtection.ModeBlock {
			value += "; mode=block"
		}
		if config.XSSProtection.ReportURI != "" {
			value += "; report=" + config.XSSProtection.ReportURI
		}
		setUnlessOverridden(header, "X-XSS-Protection", value, config.XSSProtection.Override)
	}
}

func setUnlessOverridden(header http.Header, name, value string, override bool) {
	if override || len(header.Values(name)) == 0 {
		header.Set(name, value)
	}
}

func urlQueryUnescape(value string) (string, error) {
	return url.QueryUnescape(value)
}

func isHopByHopHeader(name string) bool {
	switch http.CanonicalHeaderKey(name) {
	case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
		"Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	default:
		return false
	}
}
