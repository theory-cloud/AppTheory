package localcloudfront

import (
	"encoding/json"
	"strings"
	"testing"
)

// parseConfigError parses one DistributionConfig and returns the error the
// reader produced (nil when the config is understood).
func parseConfigError(config map[string]any) error {
	_, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Distribution": {
				Type:       typeCloudFrontDistribution,
				Properties: mustJSONNoTest(map[string]any{"DistributionConfig": config}),
			},
		},
	}})
	return err
}

func mustJSONNoTest(value any) json.RawMessage {
	encoded, _ := json.Marshal(value) //nolint:errcheck // fixed test value
	return encoded
}

func TestMalformedDistributionPropertiesAreRefused(t *testing.T) {
	cases := map[string]func(map[string]any){
		"aliases type":         func(c map[string]any) { c["Aliases"] = "alias" },
		"cache behaviors type": func(c map[string]any) { c["CacheBehaviors"] = "x" },
		"comment type":         func(c map[string]any) { c["Comment"] = 7 },
		"default root object type": func(c map[string]any) {
			c["DefaultRootObject"] = 7
		},
		"enabled type":       func(c map[string]any) { c["Enabled"] = "yes" },
		"origin groups type": func(c map[string]any) { c["OriginGroups"] = "x" },
		"origins type":       func(c map[string]any) { c["Origins"] = "x" },
		"staging type":       func(c map[string]any) { c["Staging"] = "yes" },
		"custom errors type": func(c map[string]any) { c["CustomErrorResponses"] = "x" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			mutate(config)
			if err := parseConfigError(config); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

func TestMalformedCacheBehaviorsAreRefused(t *testing.T) {
	cases := map[string]func(map[string]any){
		"path pattern type": func(behavior map[string]any) { behavior["PathPattern"] = 7 },
		"target origin type": func(behavior map[string]any) {
			behavior["TargetOriginId"] = 7
		},
		"allowed methods type": func(behavior map[string]any) { behavior["AllowedMethods"] = "GET" },
		"cached methods type":  func(behavior map[string]any) { behavior["CachedMethods"] = "GET" },
		"viewer protocol type": func(behavior map[string]any) { behavior["ViewerProtocolPolicy"] = 7 },
		"compress type":        func(behavior map[string]any) { behavior["Compress"] = "yes" },
		"smooth streaming type": func(behavior map[string]any) {
			behavior["SmoothStreaming"] = "yes"
		},
		"function associations type": func(behavior map[string]any) {
			behavior["FunctionAssociations"] = "x"
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			behavior, ok := config["DefaultCacheBehavior"].(map[string]any)
			if !ok {
				t.Fatalf("test config has no DefaultCacheBehavior")
			}
			mutate(behavior)
			if err := parseConfigError(config); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
	config := baseDistributionConfig()
	clientBehavior := map[string]any{
		"PathPattern":    "/api/*",
		"TargetOriginId": "Origin1",
		"AllowedMethods": []any{"GET"},
		"CachePolicyId":  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
	}
	config["CacheBehaviors"] = []any{clientBehavior}
	if err := parseConfigError(config); err != nil {
		t.Fatalf("a well-formed ordered behavior must parse: %v", err)
	}
	clientBehavior["PathPattern"] = ""
	if distribution := parseDistributionConfig(t, config); distribution.Servable() {
		t.Fatal("a behavior without a PathPattern must refuse the distribution")
	}
}

func TestMalformedCustomErrorResponsesAreRefused(t *testing.T) {
	cases := map[string]map[string]any{
		"error code type":       {"ErrorCode": "404"},
		"page path type":        {"ErrorCode": 404, "ResponsePagePath": 7},
		"response code type":    {"ErrorCode": 404, "ResponseCode": "200"},
		"caching ttl type":      {"ErrorCode": 404, "ErrorCachingMinTTL": "60"},
		"non-error code":        {"ErrorCode": 200},
		"relative page path":    {"ErrorCode": 404, "ResponsePagePath": "errors/404.html"},
		"invalid response code": {"ErrorCode": 404, "ResponseCode": 100},
		"negative ttl":          {"ErrorCode": 404, "ErrorCachingMinTTL": -1},
	}
	for name, entry := range cases {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			config["CustomErrorResponses"] = []any{entry}
			if err := parseConfigError(config); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
	config := baseDistributionConfig()
	config["CustomErrorResponses"] = []any{map[string]any{
		"ErrorCode": 404, "ResponsePagePath": "/errors/404.html", "ResponseCode": 200, "ErrorCachingMinTTL": 60,
	}}
	distribution := parseDistributionConfig(t, config)
	if len(distribution.CustomErrorResponses) != 1 || distribution.CustomErrorResponses[0].ErrorCode != 404 {
		t.Fatalf("custom errors = %+v", distribution.CustomErrorResponses)
	}
	if _, ok := distribution.CustomErrorResponseFor(500); ok {
		t.Fatal("an unconfigured error code must not match")
	}
}

func TestMalformedCachePoliciesAreRefused(t *testing.T) {
	cases := map[string]string{
		"min ttl type":                 `{"MinTTL":"x"}`,
		"default ttl type":             `{"DefaultTTL":"x"}`,
		"max ttl type":                 `{"MaxTTL":"x"}`,
		"parameters type":              `{"ParametersInCacheKeyAndForwardedToOrigin":"x"}`,
		"headers type":                 `{"ParametersInCacheKeyAndForwardedToOrigin":{"HeadersConfig":"x"}}`,
		"all viewer in a cache policy": `{"ParametersInCacheKeyAndForwardedToOrigin":{"HeadersConfig":{"HeaderBehavior":"allViewer"}}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			policy := &Policy{Kind: PolicyCache}
			if _, err := parseCachePolicyConfig(json.RawMessage(raw), policy); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
	policy := &Policy{Kind: PolicyCache}
	cache, err := parseCachePolicyConfig(json.RawMessage(`{"MinTTL":1,"DefaultTTL":60,"MaxTTL":3600,"Comment":"x"}`), policy)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cache.MinTTL != 1 || cache.DefaultTTL != 60 || cache.MaxTTL != 3600 {
		t.Fatalf("ttls = %+v", cache)
	}
	refusalPolicy := &Policy{Kind: PolicyCache}
	if _, err := parseCachePolicyConfig(json.RawMessage(`{"Unexpected":true}`), refusalPolicy); err != nil {
		t.Fatalf("an unknown top-level property is a refusal, not an error: %v", err)
	}
	if len(refusalPolicy.Refusals) == 0 || !strings.Contains(strings.Join(refusalPolicy.Refusals, ";"), "Unexpected") {
		t.Fatalf("unknown property refusal = %+v", refusalPolicy.Refusals)
	}
	policy = &Policy{Kind: PolicyCache}
	if _, err := parseCachePolicyConfig(json.RawMessage(`{"HeadersConfig":"x"}`), policy); err != nil {
		t.Fatalf("an unparsed top-level property must not error: %v", err)
	}
}

func TestMalformedOriginPoliciesAreRefused(t *testing.T) {
	cases := map[string]string{
		"headers type":     `{"HeadersConfig":"x"}`,
		"unknown behavior": `{"HeadersConfig":{"HeaderBehavior":"sometimes"}}`,
		"cookies type":     `{"CookiesConfig":{"CookieBehavior":"sometimes"}}`,
		"query type":       `{"QueryStringsConfig":{"QueryStringBehavior":"sometimes"}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			policy := &Policy{Kind: PolicyOriginRequest}
			if _, err := parseOriginRequestPolicyConfig(json.RawMessage(raw), policy); err == nil {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

func TestMalformedOriginsAreRefused(t *testing.T) {
	typeErrors := map[string]func(map[string]any){
		"origin id type":     func(origin map[string]any) { origin["Id"] = 7 },
		"origin path type":   func(origin map[string]any) { origin["OriginPath"] = 7 },
		"custom config type": func(origin map[string]any) { origin["CustomOriginConfig"] = "x" },
		"s3 config type":     func(origin map[string]any) { origin["S3OriginConfig"] = "x" },
	}
	for name, mutate := range typeErrors {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			origin, ok := config["Origins"].([]any)[0].(map[string]any)
			if !ok {
				t.Fatalf("test config has no origin")
			}
			mutate(origin)
			if err := parseConfigError(config); err == nil {
				t.Fatalf("%s must be an error", name)
			}
		})
	}
	refusals := map[string]func(map[string]any){
		"domain type": func(origin map[string]any) { origin["DomainName"] = 7 },
		"oac ref missing": func(origin map[string]any) {
			origin["OriginAccessControlId"] = map[string]any{"Ref": "Missing"}
		},
		"custom headers type":       func(origin map[string]any) { origin["OriginCustomHeaders"] = "x" },
		"origin path without slash": func(origin map[string]any) { origin["OriginPath"] = "prod" },
	}
	for name, mutate := range refusals {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			origin, ok := config["Origins"].([]any)[0].(map[string]any)
			if !ok {
				t.Fatalf("test config has no origin")
			}
			mutate(origin)
			distribution := parseDistributionConfig(t, config)
			if distribution.Servable() || len(distribution.Refusals) == 0 {
				t.Fatalf("%s must refuse the distribution: %+v", name, distribution.Refusals)
			}
		})
	}
}

func TestOriginWithoutAConfigIsRefused(t *testing.T) {
	config := baseDistributionConfig()
	origin, ok := config["Origins"].([]any)[0].(map[string]any)
	if !ok {
		t.Fatalf("test config has no origin")
	}
	delete(origin, "CustomOriginConfig")
	distribution := parseDistributionConfig(t, config)
	if distribution.Servable() {
		t.Fatal("an origin with no S3 or custom config must refuse the distribution")
	}
}
