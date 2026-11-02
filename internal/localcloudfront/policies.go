package localcloudfront

import (
	"encoding/json"
	"fmt"
	"strings"
)

// managedPolicyTable is the pinned id -> definition table for the AWS managed
// CloudFront policies the gateway understands. The definitions come from the
// CloudFront developer guide. An id that is not here is refused rather than
// guessed.
var managedPolicyTable = map[PolicyKind]map[string]*Policy{
	PolicyCache: {
		// CachingOptimized.
		"658327ea-f89d-4fab-a63d-7e88639e58f6": {
			Kind: PolicyCache, ID: "658327ea-f89d-4fab-a63d-7e88639e58f6", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardNone},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// CachingDisabled.
		"4135ea2d-6df8-44a3-9df3-4b5a84be39ad": {
			Kind: PolicyCache, ID: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardNone},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// CachingOptimizedForUncompressedObjects.
		"b2884449-e4de-46a7-ac36-70bc7f1ddd6d": {
			Kind: PolicyCache, ID: "b2884449-e4de-46a7-ac36-70bc7f1ddd6d", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardNone},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// Amplify.
		"2e54312d-136d-493c-8eb9-b001f22f67d2": {
			Kind: PolicyCache, ID: "2e54312d-136d-493c-8eb9-b001f22f67d2", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"authorization", "cloudfront-viewer-country", "host"}},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
		},
		// Elemental-MediaPackage.
		"08627262-05a9-4f76-9ded-b50ca2e3a84f": {
			Kind: PolicyCache, ID: "08627262-05a9-4f76-9ded-b50ca2e3a84f", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"origin"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardWhitelist, Names: []string{"aws.manifestfilter", "start", "end", "m"}},
			},
		},
		// UseOriginCacheControlHeaders.
		"83da9c7e-98b4-4e11-a168-04f0df8e2c65": {
			Kind: PolicyCache, ID: "83da9c7e-98b4-4e11-a168-04f0df8e2c65", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"host", "origin", "x-http-method-override", "x-http-method", "x-method-override"}},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// UseOriginCacheControlHeaders-QueryStrings.
		"4cc15a8a-d715-48a4-82b8-cc0b614638fe": {
			Kind: PolicyCache, ID: "4cc15a8a-d715-48a4-82b8-cc0b614638fe", Managed: true,
			Cache: &CachePolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"host", "origin", "x-http-method-override", "x-http-method", "x-method-override"}},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
		},
	},
	PolicyOriginRequest: {
		// AllViewer.
		"216adef6-5c7f-47e4-b989-5492eafa07d3": {
			Kind: PolicyOriginRequest, ID: "216adef6-5c7f-47e4-b989-5492eafa07d3", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardAll},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
		},
		// AllViewerAndCloudFrontHeaders-2022-06.
		"33f36d7e-f396-46d9-90e0-52428a34d9dc": {
			Kind: PolicyOriginRequest, ID: "33f36d7e-f396-46d9-90e0-52428a34d9dc", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardAll, CloudFrontHeaders: true},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
			Reported: []string{"CloudFront device, location and TLS headers are not generated locally"},
		},
		// AllViewerExceptHostHeader.
		"b689b0a8-53d0-40ab-baf2-68738e2966ac": {
			Kind: PolicyOriginRequest, ID: "b689b0a8-53d0-40ab-baf2-68738e2966ac", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardAllExcept, Names: []string{"host"}, CloudFrontHeaders: true},
				Cookies:      CookieForwarding{Mode: ForwardAll},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
			Reported: []string{"CloudFront device, location and TLS headers are not generated locally; the Host header is set to the origin domain"},
		},
		// CORS-CustomOrigin.
		"59781a5b-3903-41f3-afcb-af62929ccde1": {
			Kind: PolicyOriginRequest, ID: "59781a5b-3903-41f3-afcb-af62929ccde1", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"origin"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// CORS-S3Origin.
		"88a5eaf4-2fd4-4709-b370-b4c650ea3fcf": {
			Kind: PolicyOriginRequest, ID: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"origin", "access-control-request-headers", "access-control-request-method"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// Elemental-MediaTailor-PersonalizedManifests.
		"775133bc-15f2-49f9-abea-afb2e0bf67d2": {
			Kind: PolicyOriginRequest, ID: "775133bc-15f2-49f9-abea-afb2e0bf67d2", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"origin", "access-control-request-headers", "access-control-request-method", "user-agent", "x-forwarded-for"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardAll},
			},
		},
		// HostHeaderOnly.
		"bf0718e1-ba1e-49d1-88b1-f726733018ae": {
			Kind: PolicyOriginRequest, ID: "bf0718e1-ba1e-49d1-88b1-f726733018ae", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"host"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
		// UserAgentRefererHeaders.
		"acba4595-bd28-49b8-b9fe-13317c0390fa": {
			Kind: PolicyOriginRequest, ID: "acba4595-bd28-49b8-b9fe-13317c0390fa", Managed: true,
			OriginRequest: &OriginRequestPolicy{
				Headers:      HeaderForwarding{Mode: ForwardWhitelist, Names: []string{"user-agent", "referer"}},
				Cookies:      CookieForwarding{Mode: ForwardNone},
				QueryStrings: QueryForwarding{Mode: ForwardNone},
			},
		},
	},
	PolicyResponseHeaders: {
		// SimpleCORS.
		"60669652-455b-4ae9-85a4-c4c02393f86c": {
			Kind: PolicyResponseHeaders, ID: "60669652-455b-4ae9-85a4-c4c02393f86c", Managed: true,
			ResponseHeaders: &ResponseHeadersPolicy{
				CORS: &CORSConfig{AllowOrigins: []string{"*"}},
			},
		},
		// CORS-With-Preflight.
		"5cc3b908-e619-4b99-88e5-2cf7f45965bd": {
			Kind: PolicyResponseHeaders, ID: "5cc3b908-e619-4b99-88e5-2cf7f45965bd", Managed: true,
			ResponseHeaders: &ResponseHeadersPolicy{
				CORS: &CORSConfig{
					AllowOrigins:  []string{"*"},
					AllowMethods:  []string{"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"},
					ExposeHeaders: []string{"*"},
				},
			},
		},
		// SecurityHeadersPolicy.
		"67f7725c-6f97-4210-82d7-5512b31e9d03": {
			Kind: PolicyResponseHeaders, ID: "67f7725c-6f97-4210-82d7-5512b31e9d03", Managed: true,
			ResponseHeaders: &ResponseHeadersPolicy{Security: securityHeadersPolicy()},
		},
		// CORS-and-SecurityHeadersPolicy.
		"e61eb60c-9c35-4d20-a928-2b84e02af89c": {
			Kind: PolicyResponseHeaders, ID: "e61eb60c-9c35-4d20-a928-2b84e02af89c", Managed: true,
			ResponseHeaders: &ResponseHeadersPolicy{
				CORS:     &CORSConfig{AllowOrigins: []string{"*"}},
				Security: securityHeadersPolicy(),
			},
		},
		// CORS-with-preflight-and-SecurityHeadersPolicy.
		"eaab4381-ed33-4a86-88ca-d9558dc6cd63": {
			Kind: PolicyResponseHeaders, ID: "eaab4381-ed33-4a86-88ca-d9558dc6cd63", Managed: true,
			ResponseHeaders: &ResponseHeadersPolicy{
				CORS: &CORSConfig{
					AllowOrigins:  []string{"*"},
					AllowMethods:  []string{"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"},
					ExposeHeaders: []string{"*"},
				},
				Security: securityHeadersPolicy(),
			},
		},
	},
}

func securityHeadersPolicy() *SecurityHeaders {
	return &SecurityHeaders{
		ReferrerPolicy: &ReferrerPolicy{Value: "strict-origin-when-cross-origin"},
		StrictTransportSecurity: &StrictTransportSecurity{
			MaxAgeSeconds: 31536000,
		},
		ContentTypeOptions: &ContentTypeOptions{Override: true},
		FrameOptions:       &FrameOptions{Value: "SAMEORIGIN"},
		XSSProtection:      &XSSProtection{Protection: true, ModeBlock: true},
	}
}

// managedPolicy looks up a pinned managed policy by id and kind.
func managedPolicy(id string, kind PolicyKind) (*Policy, bool) {
	policies, ok := managedPolicyTable[kind]
	if !ok {
		return nil, false
	}
	policy, ok := policies[id]
	if !ok {
		return nil, false
	}
	cloned := *policy
	return &cloned, true
}

// ManagedPolicyIDs returns the ids in the pinned table for one kind. Tests use
// it to prove the table covers every id a shipped construct references.
func ManagedPolicyIDs(kind PolicyKind) []string {
	policies := managedPolicyTable[kind]
	ids := make([]string, 0, len(policies))
	for id := range policies {
		ids = append(ids, id)
	}
	sortStrings(ids)
	return ids
}

func policyKindForType(resourceType string) (PolicyKind, bool) {
	switch resourceType {
	case typeCachePolicy:
		return PolicyCache, true
	case typeOriginRequestPolicy:
		return PolicyOriginRequest, true
	case typeResponseHeadersPolicy:
		return PolicyResponseHeaders, true
	default:
		return "", false
	}
}

func parsePolicy(
	stack, id string,
	kind PolicyKind,
	resource Resource,
	index *resourceIndex,
) (*Policy, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	policy := &Policy{Kind: kind, ID: index.qualified(stack, id), LogicalID: index.qualified(stack, id)}
	switch kind {
	case PolicyCache:
		config, ok := properties["CachePolicyConfig"]
		if !ok {
			policy.Refusals = append(policy.Refusals, "CachePolicyConfig is missing")
			return policy, nil
		}
		var err error
		policy.Cache, err = parseCachePolicyConfig(config, policy)
		if err != nil {
			return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
		}
	case PolicyOriginRequest:
		config, ok := properties["OriginRequestPolicyConfig"]
		if !ok {
			policy.Refusals = append(policy.Refusals, "OriginRequestPolicyConfig is missing")
			return policy, nil
		}
		var err error
		policy.OriginRequest, err = parseOriginRequestPolicyConfig(config, policy)
		if err != nil {
			return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
		}
	case PolicyResponseHeaders:
		config, ok := properties["ResponseHeadersPolicyConfig"]
		if !ok {
			policy.Refusals = append(policy.Refusals, "ResponseHeadersPolicyConfig is missing")
			return policy, nil
		}
		var err error
		policy.ResponseHeaders, err = parseResponseHeadersPolicyConfig(config, policy)
		if err != nil {
			return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
		}
	}
	return policy, nil
}

func parseCachePolicyConfig(raw json.RawMessage, policy *Policy) (*CachePolicy, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	cache := &CachePolicy{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case propertyName, propertyComment:
			policy.Reported = append(policy.Reported, reportProperty("cache policy", key))
		case propertyDefaultTTL, propertyMaxTTL, propertyMinTTL:
			policy.Reported = append(policy.Reported, reportProperty("cache policy", key))
		case "ParametersInCacheKeyAndForwardedToOrigin":
			parameters, err := decodeObject(value)
			if err != nil {
				return nil, fmt.Errorf("ParametersInCacheKeyAndForwardedToOrigin: %w", err)
			}
			for _, parameterKey := range sortedKeys(parameters) {
				parameterValue := parameters[parameterKey]
				switch parameterKey {
				case "HeadersConfig":
					cache.Headers, err = parseHeaderForwarding(parameterValue, false)
				case "CookiesConfig":
					cache.Cookies, err = parseCookieForwarding(parameterValue)
				case "QueryStringsConfig":
					cache.QueryStrings, err = parseQueryForwarding(parameterValue)
				case "EnableAcceptEncodingBrotli", "EnableAcceptEncodingGzip":
					policy.Reported = append(policy.Reported, reportProperty("cache policy", parameterKey))
				default:
					if _, known := cacheParametersPropertyInventory[parameterKey]; !known {
						policy.Refusals = append(policy.Refusals,
							fmt.Sprintf("ParametersInCacheKeyAndForwardedToOrigin property %q is not understood", parameterKey))
					}
				}
				if err != nil {
					return nil, err
				}
			}
		default:
			if _, known := cachePolicyPropertyInventory[key]; !known {
				policy.Refusals = append(policy.Refusals,
					fmt.Sprintf("CachePolicyConfig property %q is not understood", key))
			}
		}
	}
	reportCloudFrontHeaderGaps(policy, "cache policy", cache.Headers)
	return cache, nil
}

func parseOriginRequestPolicyConfig(raw json.RawMessage, policy *Policy) (*OriginRequestPolicy, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return nil, err
	}
	origin := &OriginRequestPolicy{}
	for _, key := range sortedKeys(properties) {
		value := properties[key]
		switch key {
		case propertyName, propertyComment:
			policy.Reported = append(policy.Reported, reportProperty("origin request policy", key))
		case "HeadersConfig":
			origin.Headers, err = parseHeaderForwarding(value, true)
		case "CookiesConfig":
			origin.Cookies, err = parseCookieForwarding(value)
		case "QueryStringsConfig":
			origin.QueryStrings, err = parseQueryForwarding(value)
		default:
			if _, known := originRequestPolicyPropertyInventory[key]; !known {
				policy.Refusals = append(policy.Refusals,
					fmt.Sprintf("OriginRequestPolicyConfig property %q is not understood", key))
			}
		}
		if err != nil {
			return nil, err
		}
	}
	reportCloudFrontHeaderGaps(policy, "origin request policy", origin.Headers)
	return origin, nil
}

//nolint:gocyclo // the switch enumerates CloudFront header behaviors
func parseHeaderForwarding(raw json.RawMessage, allowAllViewer bool) (HeaderForwarding, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return HeaderForwarding{}, err
	}
	config := HeaderForwarding{Mode: ForwardNone}
	for _, key := range sortedKeys(properties) {
		switch key {
		case "HeaderBehavior":
			var behavior string
			if err := json.Unmarshal(properties[key], &behavior); err != nil {
				return config, fmt.Errorf("HeaderBehavior: %w", err)
			}
			switch behavior {
			case "none":
				config.Mode = ForwardNone
			case "whitelist":
				config.Mode = ForwardWhitelist
			case "allViewer":
				if !allowAllViewer {
					return config, fmt.Errorf("HeaderBehavior %q is not valid for a cache policy", behavior)
				}
				config.Mode = ForwardAll
			case "allViewerAndWhitelistCloudFront":
				if !allowAllViewer {
					return config, fmt.Errorf("HeaderBehavior %q is not valid for a cache policy", behavior)
				}
				config.Mode = ForwardAll
				config.CloudFrontHeaders = true
			case "allExcept":
				if !allowAllViewer {
					return config, fmt.Errorf("HeaderBehavior %q is not valid for a cache policy", behavior)
				}
				config.Mode = ForwardAllExcept
				config.CloudFrontHeaders = true
			default:
				return config, fmt.Errorf("HeaderBehavior %q is not supported locally", behavior)
			}
		case "Headers":
			if err := json.Unmarshal(properties[key], &config.Names); err != nil {
				return config, fmt.Errorf("headers: %w", err)
			}
			config.Names = lowerStrings(config.Names)
		default:
			if _, known := forwardingConfigPropertyInventory[key]; !known {
				return config, fmt.Errorf("headers config property %q is not understood", key)
			}
		}
	}
	return config, nil
}

type forwardingFields struct {
	Mode  ForwardingMode
	Names []string
}

func parseForwardingFields(
	raw json.RawMessage,
	behaviorKey, namesKey, context string,
) (forwardingFields, error) {
	properties, err := decodeObject(raw)
	if err != nil {
		return forwardingFields{}, err
	}
	fields := forwardingFields{Mode: ForwardNone}
	for _, key := range sortedKeys(properties) {
		switch key {
		case behaviorKey:
			var behavior string
			if err := json.Unmarshal(properties[key], &behavior); err != nil {
				return fields, fmt.Errorf("%s: %w", behaviorKey, err)
			}
			fields.Mode = ForwardingMode(behavior)
			if !validMode(fields.Mode) {
				return fields, fmt.Errorf("%s %q is not supported locally", behaviorKey, behavior)
			}
		case namesKey:
			if err := json.Unmarshal(properties[key], &fields.Names); err != nil {
				return fields, fmt.Errorf("%s: %w", namesKey, err)
			}
		default:
			if _, known := forwardingConfigPropertyInventory[key]; !known {
				return fields, fmt.Errorf("%s config property %q is not understood", context, key)
			}
		}
	}
	return fields, nil
}

func parseCookieForwarding(raw json.RawMessage) (CookieForwarding, error) {
	fields, err := parseForwardingFields(raw, "CookieBehavior", "Cookies", "cookies")
	if err != nil {
		return CookieForwarding{}, err
	}
	return CookieForwarding(fields), nil
}

func parseQueryForwarding(raw json.RawMessage) (QueryForwarding, error) {
	fields, err := parseForwardingFields(raw, "QueryStringBehavior", "QueryStrings", "query strings")
	if err != nil {
		return QueryForwarding{}, err
	}
	return QueryForwarding(fields), nil
}

func validMode(mode ForwardingMode) bool {
	switch mode {
	case ForwardNone, ForwardWhitelist, ForwardAll, ForwardAllExcept:
		return true
	default:
		return false
	}
}

func reportCloudFrontHeaderGaps(policy *Policy, context string, config HeaderForwarding) {
	if config.CloudFrontHeaders {
		policy.Reported = append(policy.Reported,
			context+": CloudFront device, location and TLS headers are not generated locally")
	}
	for _, name := range config.Names {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "cloudfront-") && !derivableCloudFrontHeader(lower) {
			policy.Reported = append(policy.Reported,
				fmt.Sprintf("%s: CloudFront header %s is not generated locally", context, name))
		}
	}
}

func derivableCloudFrontHeader(name string) bool {
	switch name {
	case "cloudfront-forwarded-proto", "cloudfront-viewer-address", "cloudfront-viewer-http-version":
		return true
	default:
		return false
	}
}

func lowerStrings(values []string) []string {
	out := make([]string, len(values))
	for index, value := range values {
		out[index] = lowerHeaderName(value)
	}
	return out
}
