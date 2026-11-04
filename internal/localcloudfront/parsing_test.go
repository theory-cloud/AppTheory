package localcloudfront

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return encoded
}

func parseDistributionConfig(t *testing.T, config map[string]any) *Distribution {
	t.Helper()
	topology, err := ParseTemplates([]Template{{
		Stack: "TestStack",
		Resources: map[string]Resource{
			"Distribution": {
				Type:       typeCloudFrontDistribution,
				Properties: mustJSON(t, map[string]any{"DistributionConfig": config}),
			},
		},
	}})
	if err != nil {
		t.Fatalf("parse distribution: %v", err)
	}
	if len(topology.Distributions) != 1 {
		t.Fatalf("distributions = %d", len(topology.Distributions))
	}
	return topology.Distributions[0]
}

func baseDistributionConfig() map[string]any {
	return map[string]any{
		"Enabled": true,
		"Origins": []any{
			map[string]any{
				"Id":         "Origin1",
				"DomainName": "origin.example",
				"CustomOriginConfig": map[string]any{
					"OriginProtocolPolicy": "https-only",
				},
			},
		},
		"DefaultCacheBehavior": map[string]any{
			"TargetOriginId":        "Origin1",
			"AllowedMethods":        []any{"GET", "HEAD"},
			"CachePolicyId":         "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
			"OriginRequestPolicyId": map[string]any{"Ref": "OriginPolicy"},
			"ViewerProtocolPolicy":  "redirect-to-https",
		},
	}
}

func TestDistributionPropertyDispositions(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(map[string]any)
		wantRefuse string
		wantReport string
	}{
		{name: "comment", mutate: func(c map[string]any) { c["Comment"] = "hello" }, wantReport: "Comment"},
		{name: "aliases", mutate: func(c map[string]any) { c["Aliases"] = []any{"a.example"} }, wantReport: "Aliases"},
		{name: "http version", mutate: func(c map[string]any) { c["HttpVersion"] = "http2" }, wantReport: "HttpVersion"},
		{name: "ipv6", mutate: func(c map[string]any) { c["IPV6Enabled"] = true }, wantReport: "IPV6Enabled"},
		{name: "logging", mutate: func(c map[string]any) { c["Logging"] = map[string]any{"Bucket": "b"} }, wantReport: "Logging"},
		{name: "price class", mutate: func(c map[string]any) { c["PriceClass"] = "PriceClass_100" }, wantReport: "PriceClass"},
		{name: "certificate", mutate: func(c map[string]any) { c["ViewerCertificate"] = map[string]any{"CloudFrontDefaultCertificate": true} }, wantReport: "ViewerCertificate"},
		{name: "staging false", mutate: func(c map[string]any) { c["Staging"] = false }, wantReport: "Staging"},
		{name: "staging true", mutate: func(c map[string]any) { c["Staging"] = true }, wantRefuse: "Staging"},
		{name: "web acl", mutate: func(c map[string]any) { c["WebACLId"] = "arn:aws:wafv2:::global/webacl/x" }, wantRefuse: "WebACLId"},
		{name: "web acl empty", mutate: func(c map[string]any) { c["WebACLId"] = "" }, wantReport: "WebACLId"},
		{name: "continuous deployment", mutate: func(c map[string]any) { c["ContinuousDeploymentPolicyId"] = "p" }, wantRefuse: "ContinuousDeploymentPolicyId"},
		{name: "continuous deployment empty", mutate: func(c map[string]any) { c["ContinuousDeploymentPolicyId"] = "" }, wantReport: "ContinuousDeploymentPolicyId"},
		{name: "restrictions", mutate: func(c map[string]any) { c["Restrictions"] = map[string]any{"GeoRestriction": map[string]any{}} }, wantRefuse: "Restrictions"},
		{name: "disabled", mutate: func(c map[string]any) { c["Enabled"] = false }, wantRefuse: "Enabled"},
		{name: "unknown", mutate: func(c map[string]any) { c["SomethingNew"] = true }, wantRefuse: "SomethingNew"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			config := baseDistributionConfig()
			test.mutate(config)
			distribution := parseDistributionConfig(t, config)
			refusals := strings.Join(distribution.Refusals, "\n")
			reports := strings.Join(distribution.Reported, "\n")
			if test.wantRefuse != "" && !strings.Contains(refusals, test.wantRefuse) {
				t.Fatalf("refusals do not contain %q:\n%s", test.wantRefuse, refusals)
			}
			if test.wantReport != "" && !strings.Contains(reports, test.wantReport) {
				t.Fatalf("reports do not contain %q:\n%s", test.wantReport, reports)
			}
		})
	}
}

func TestBehaviorCachedMethodsDefaultsToGetHeadAndIsParsed(t *testing.T) {
	config := baseDistributionConfig()
	distribution := parseDistributionConfig(t, config)
	if got := strings.Join(distribution.DefaultBehavior.CachedMethods, ","); got != "GET,HEAD" {
		t.Fatalf("default CachedMethods = %q, want GET,HEAD", got)
	}
	if refusals := strings.Join(distribution.DefaultBehavior.Refusals, "\n"); strings.Contains(refusals, "CachedMethods") {
		t.Fatalf("the default CachedMethods must not be refused: %s", refusals)
	}

	behavior := mustMap(t, config["DefaultCacheBehavior"], "DefaultCacheBehavior")
	behavior["CachedMethods"] = []any{"GET", "HEAD", "OPTIONS"}
	distribution = parseDistributionConfig(t, config)
	if got := strings.Join(distribution.DefaultBehavior.CachedMethods, ","); got != "GET,HEAD,OPTIONS" {
		t.Fatalf("parsed CachedMethods = %q, want GET,HEAD,OPTIONS", got)
	}
	if refusals := strings.Join(distribution.DefaultBehavior.Refusals, "\n"); strings.Contains(refusals, "CachedMethods") {
		t.Fatalf("CachedMethods must be parsed, not refused: %s", refusals)
	}
}

func TestBehaviorPropertyDispositions(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(map[string]any)
		wantRefuse string
		wantReport string
	}{
		{name: "compress", mutate: func(b map[string]any) { b["Compress"] = true }, wantReport: "Compress"},
		{name: "cached methods", mutate: func(b map[string]any) { b["CachedMethods"] = []any{"GET"} }, wantReport: "CachedMethods"},
		{name: "ttl", mutate: func(b map[string]any) { b["DefaultTTL"] = 1 }, wantReport: "DefaultTTL"},
		{name: "real time logs", mutate: func(b map[string]any) { b["RealtimeLogConfigArn"] = "arn:x" }, wantReport: "RealtimeLogConfigArn"},
		{name: "smooth false", mutate: func(b map[string]any) { b["SmoothStreaming"] = false }, wantReport: "SmoothStreaming"},
		{name: "smooth true", mutate: func(b map[string]any) { b["SmoothStreaming"] = true }, wantRefuse: "SmoothStreaming"},
		{name: "lambda edge", mutate: func(b map[string]any) { b["LambdaFunctionAssociations"] = []any{map[string]any{}} }, wantRefuse: "LambdaFunctionAssociations"},
		{name: "lambda edge empty", mutate: func(b map[string]any) { b["LambdaFunctionAssociations"] = []any{} }, wantReport: "LambdaFunctionAssociations"},
		{name: "field encryption", mutate: func(b map[string]any) { b["FieldLevelEncryptionId"] = "x" }, wantRefuse: "FieldLevelEncryptionId"},
		{name: "forwarded values", mutate: func(b map[string]any) { b["ForwardedValues"] = map[string]any{} }, wantRefuse: "ForwardedValues"},
		{name: "grpc", mutate: func(b map[string]any) { b["GrpcConfig"] = map[string]any{} }, wantRefuse: "GrpcConfig"},
		{name: "trusted key groups", mutate: func(b map[string]any) { b["TrustedKeyGroups"] = []any{"g"} }, wantRefuse: "TrustedKeyGroups"},
		{name: "trusted signers", mutate: func(b map[string]any) { b["TrustedSigners"] = []any{"s"} }, wantRefuse: "TrustedSigners"},
		{name: "unknown", mutate: func(b map[string]any) { b["SomethingNew"] = true }, wantRefuse: "SomethingNew"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			config := baseDistributionConfig()
			behavior := mustMap(t, config["DefaultCacheBehavior"], "DefaultCacheBehavior")
			test.mutate(behavior)
			distribution := parseDistributionConfig(t, config)
			refusals := strings.Join(distribution.Refusals, "\n")
			reports := strings.Join(distribution.Reported, "\n")
			for _, behavior := range append([]*Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...) {
				refusals += "\n" + strings.Join(behavior.Refusals, "\n")
				reports += "\n" + strings.Join(behavior.Reported, "\n")
			}
			if test.wantRefuse != "" && !strings.Contains(refusals, test.wantRefuse) {
				t.Fatalf("refusals do not contain %q:\n%s", test.wantRefuse, refusals)
			}
			if test.wantReport != "" && !strings.Contains(reports, test.wantReport) {
				t.Fatalf("reports do not contain %q:\n%s", test.wantReport, reports)
			}
		})
	}
}

func TestOriginPropertyDispositions(t *testing.T) {
	cases := []struct {
		name       string
		mutate     func(map[string]any)
		wantRefuse string
		wantReport string
	}{
		{name: "connection attempts", mutate: func(o map[string]any) { o["ConnectionAttempts"] = 3 }, wantReport: "ConnectionAttempts"},
		{name: "origin shield", mutate: func(o map[string]any) { o["OriginShield"] = map[string]any{"Enabled": true} }, wantReport: "OriginShield"},
		{name: "custom headers", mutate: func(o map[string]any) {
			o["OriginCustomHeaders"] = []any{map[string]any{"HeaderName": "X-Origin", "HeaderValue": "yes"}}
		}},
		{name: "custom header bad", mutate: func(o map[string]any) {
			o["OriginCustomHeaders"] = []any{map[string]any{"Other": "x"}}
		}, wantRefuse: "OriginCustomHeaders"},
		{name: "no domain", mutate: func(o map[string]any) { delete(o, "DomainName") }, wantRefuse: "DomainName"},
		{name: "unresolved domain", mutate: func(o map[string]any) { o["DomainName"] = map[string]any{"Fn::Sub": "x"} }, wantRefuse: "DomainName"},
		{name: "no config", mutate: func(o map[string]any) { delete(o, "CustomOriginConfig") }, wantRefuse: "CustomOriginConfig"},
		{name: "both configs", mutate: func(o map[string]any) { o["S3OriginConfig"] = map[string]any{} }, wantRefuse: "both"},
		{name: "origin path no slash", mutate: func(o map[string]any) { o["OriginPath"] = "prod" }, wantRefuse: "OriginPath"},
		{name: "s3", mutate: func(o map[string]any) {
			o["DomainName"] = map[string]any{"Fn::GetAtt": []any{"Bucket", "RegionalDomainName"}}
			delete(o, "CustomOriginConfig")
			o["S3OriginConfig"] = map[string]any{"OriginAccessIdentity": "oai"}
		}},
		{name: "function url", mutate: func(o map[string]any) {
			o["DomainName"] = map[string]any{"Fn::GetAtt": []any{"Url", "FunctionUrl"}}
		}, wantReport: ""},
		{name: "oac", mutate: func(o map[string]any) { o["OriginAccessControlId"] = map[string]any{"Fn::GetAtt": []any{"OAC", "Id"}} }, wantReport: "origin access control"},
		{name: "unknown", mutate: func(o map[string]any) { o["SomethingNew"] = true }, wantRefuse: "SomethingNew"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			config := baseDistributionConfig()
			origin := mustMap(t, mustSlice(t, config["Origins"], "Origins")[0], "Origin")
			test.mutate(origin)
			resources := map[string]Resource{
				"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": config})},
				"Bucket":       {Type: typeS3Bucket, Properties: json.RawMessage(`{}`)},
				"Url":          {Type: typeFunctionURL, Properties: json.RawMessage(`{}`)},
				"OAC":          {Type: typeOriginAccessControl, Properties: json.RawMessage(`{"OriginAccessControlConfig":{"OriginAccessControlOriginType":"s3","SigningBehavior":"always","SigningProtocol":"sigv4"}}`)},
			}
			topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: resources}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			distribution := topology.Distributions[0]
			refusals := strings.Join(distribution.Refusals, "\n")
			reports := strings.Join(distribution.Reported, "\n")
			for _, origin := range distribution.Origins {
				refusals += "\n" + strings.Join(origin.Refusals, "\n")
				reports += "\n" + strings.Join(origin.Reported, "\n")
			}
			if test.wantRefuse != "" && !strings.Contains(refusals, test.wantRefuse) {
				t.Fatalf("refusals do not contain %q:\n%s", test.wantRefuse, refusals)
			}
			if test.wantReport != "" && !strings.Contains(reports, test.wantReport) {
				t.Fatalf("reports do not contain %q:\n%s", test.wantReport, reports)
			}
		})
	}
}

func TestFunctionPropertyDispositions(t *testing.T) {
	cases := []struct {
		name       string
		properties map[string]any
		wantRefuse string
		wantReport string
	}{
		{name: "normal", properties: map[string]any{"FunctionCode": "function handler(event){return event.request;}", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}}},
		{name: "auto publish", properties: map[string]any{"AutoPublish": true, "FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}, "Name": "n"}, wantReport: "AutoPublish"},
		{name: "kvs", properties: map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20, "KeyValueStoreAssociations": []any{}}}, wantRefuse: "KeyValueStoreAssociations"},
		{name: "kvs top", properties: map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}, "KeyValueStoreAssociations": []any{}}, wantRefuse: "KeyValueStoreAssociations"},
		{name: "runtime", properties: map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": "nodejs24.x"}}, wantRefuse: "runtime"},
		{name: "empty", properties: map[string]any{"FunctionConfig": map[string]any{"Runtime": runtimeJS20}}, wantRefuse: "FunctionCode"},
		{name: "unknown", properties: map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20}, "SomethingNew": true}, wantRefuse: "SomethingNew"},
		{name: "config unknown", properties: map[string]any{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20, "SomethingNew": true}}, wantRefuse: "SomethingNew"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack: "TestStack",
				Resources: map[string]Resource{
					"Fn": {Type: typeCloudFrontFunction, Properties: mustJSON(t, test.properties)},
				},
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			function := topology.Functions[0]
			if test.wantRefuse != "" && !strings.Contains(strings.Join(function.Refusals, "\n"), test.wantRefuse) {
				t.Fatalf("refusals do not contain %q: %v", test.wantRefuse, function.Refusals)
			}
			if test.wantReport != "" && !strings.Contains(strings.Join(function.Reported, "\n"), test.wantReport) {
				t.Fatalf("reports do not contain %q: %v", test.wantReport, function.Reported)
			}
		})
	}
}

func TestPolicyParsing(t *testing.T) {
	cases := []struct {
		name       string
		kind       PolicyKind
		config     map[string]any
		wantRefuse string
		wantReport string
		wantError  bool
	}{
		{
			name: "cache all fields",
			kind: PolicyCache,
			config: map[string]any{
				"Name": "p", "Comment": "c", "DefaultTTL": 1, "MinTTL": 0, "MaxTTL": 2,
				"ParametersInCacheKeyAndForwardedToOrigin": map[string]any{
					"HeadersConfig":              map[string]any{"HeaderBehavior": "whitelist", "Headers": []any{"X-Keep"}},
					"CookiesConfig":              map[string]any{"CookieBehavior": "whitelist", "Cookies": []any{"a"}},
					"QueryStringsConfig":         map[string]any{"QueryStringBehavior": "whitelist", "QueryStrings": []any{"q"}},
					"EnableAcceptEncodingGzip":   true,
					"EnableAcceptEncodingBrotli": true,
				},
			},
			wantReport: "EnableAcceptEncoding",
		},
		{
			name: "cache all cookies",
			kind: PolicyCache,
			config: map[string]any{"ParametersInCacheKeyAndForwardedToOrigin": map[string]any{
				"CookiesConfig":      map[string]any{"CookieBehavior": "all"},
				"QueryStringsConfig": map[string]any{"QueryStringBehavior": "all"},
			}},
		},
		{
			name: "cache all except",
			kind: PolicyCache,
			config: map[string]any{"ParametersInCacheKeyAndForwardedToOrigin": map[string]any{
				"CookiesConfig":      map[string]any{"CookieBehavior": "allExcept", "Cookies": []any{"a"}},
				"QueryStringsConfig": map[string]any{"QueryStringBehavior": "whitelist", "QueryStrings": []any{"q"}},
			}},
		},
		{
			name:       "cache unknown",
			kind:       PolicyCache,
			config:     map[string]any{"SomethingNew": true},
			wantRefuse: "SomethingNew",
		},
		{
			name:      "cache malformed",
			kind:      PolicyCache,
			config:    map[string]any{"ParametersInCacheKeyAndForwardedToOrigin": map[string]any{"HeadersConfig": map[string]any{"HeaderBehavior": "all"}}},
			wantError: true,
		},
		{
			name: "origin all viewer",
			kind: PolicyOriginRequest,
			config: map[string]any{
				"Name": "p", "Comment": "c",
				"HeadersConfig":      map[string]any{"HeaderBehavior": "allViewer"},
				"CookiesConfig":      map[string]any{"CookieBehavior": "all"},
				"QueryStringsConfig": map[string]any{"QueryStringBehavior": "all"},
			},
		},
		{
			name: "origin all viewer cf",
			kind: PolicyOriginRequest,
			config: map[string]any{
				"HeadersConfig": map[string]any{"HeaderBehavior": "allViewerAndWhitelistCloudFront"},
			},
			wantReport: "CloudFront device",
		},
		{
			name: "origin all except",
			kind: PolicyOriginRequest,
			config: map[string]any{
				"HeadersConfig": map[string]any{"HeaderBehavior": "allExcept", "Headers": []any{"host", "x-keep"}},
			},
			wantReport: "CloudFront device",
		},
		{
			name: "origin cloudfront header gap",
			kind: PolicyOriginRequest,
			config: map[string]any{
				"HeadersConfig": map[string]any{"HeaderBehavior": "whitelist", "Headers": []any{"cloudfront-viewer-country", "cloudfront-forwarded-proto"}},
			},
			wantReport: "cloudfront-viewer-country",
		},
		{
			name:       "origin unknown",
			kind:       PolicyOriginRequest,
			config:     map[string]any{"SomethingNew": true},
			wantRefuse: "SomethingNew",
		},
		{
			name: "response all fields",
			kind: PolicyResponseHeaders,
			config: map[string]any{
				"Name": "p", "Comment": "c",
				"CorsConfig": map[string]any{
					"AccessControlAllowCredentials": true,
					"AccessControlAllowHeaders":     map[string]any{"Items": []any{"Content-Type"}, "Quantity": 1},
					"AccessControlAllowMethods":     []any{"GET"},
					"AccessControlAllowOrigins":     map[string]any{"Items": []any{"*"}, "Quantity": 1},
					"AccessControlExposeHeaders":    []any{"X-Expose"},
					"AccessControlMaxAgeSec":        60,
					"OriginOverride":                true,
				},
				"CustomHeadersConfig": map[string]any{"Items": []any{
					map[string]any{"Header": "X-Custom", "Value": "v", "Override": true},
				}, "Quantity": 1},
				"RemoveHeadersConfig": map[string]any{"Items": []any{map[string]any{"Header": "X-Remove"}}, "Quantity": 1},
				"SecurityHeadersConfig": map[string]any{
					"ContentSecurityPolicy":   map[string]any{"ContentSecurityPolicy": "default-src 'self'", "Override": true},
					"ContentTypeOptions":      map[string]any{"Override": true},
					"FrameOptions":            map[string]any{"FrameOption": "DENY", "Override": true},
					"ReferrerPolicy":          map[string]any{"ReferrerPolicy": "no-referrer", "Override": true},
					"StrictTransportSecurity": map[string]any{"AccessControlMaxAgeSec": 60, "IncludeSubdomains": true, "Preload": true, "Override": true},
					"XSSProtection":           map[string]any{"Protection": true, "ModeBlock": true, "ReportUri": "https://r", "Override": true},
				},
				"ServerTimingHeadersConfig": map[string]any{"Enabled": true},
			},
			wantReport: "ServerTiming",
		},
		{
			name:       "response unknown",
			kind:       PolicyResponseHeaders,
			config:     map[string]any{"SomethingNew": true},
			wantRefuse: "SomethingNew",
		},
		{
			name: "response cors bad frame",
			kind: PolicyResponseHeaders,
			config: map[string]any{
				"SecurityHeadersConfig": map[string]any{"FrameOptions": map[string]any{"FrameOption": "NOPE"}},
			},
			wantError: true,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			resourceType := typeCachePolicy
			configKey := "CachePolicyConfig"
			switch test.kind {
			case PolicyOriginRequest:
				resourceType = typeOriginRequestPolicy
				configKey = "OriginRequestPolicyConfig"
			case PolicyResponseHeaders:
				resourceType = typeResponseHeadersPolicy
				configKey = "ResponseHeadersPolicyConfig"
			}
			topology, err := ParseTemplates([]Template{{
				Stack: "TestStack",
				Resources: map[string]Resource{
					"Policy": {Type: resourceType, Properties: mustJSON(t, map[string]any{configKey: test.config})},
				},
			}})
			if err != nil {
				if test.wantError {
					return
				}
				t.Fatalf("parse: %v", err)
			}
			if test.wantError {
				t.Fatal("expected a parse error")
			}
			policy := topology.Policies[0]
			refusals := strings.Join(policy.Refusals, "\n")
			reports := strings.Join(policy.Reported, "\n")
			if test.wantRefuse != "" && !strings.Contains(refusals, test.wantRefuse) {
				t.Fatalf("refusals do not contain %q: %v", test.wantRefuse, policy.Refusals)
			}
			if test.wantReport != "" && !strings.Contains(reports, test.wantReport) {
				t.Fatalf("reports do not contain %q: %v", test.wantReport, policy.Reported)
			}
		})
	}
}

func TestOriginGroupShapesAndErrors(t *testing.T) {
	for name, group := range map[string]map[string]any{
		"object members": {
			"Id": "Group",
			"Members": map[string]any{"Items": []any{
				map[string]any{"OriginId": "Origin1"},
			}, "Quantity": 1},
			"FailoverCriteria": map[string]any{"StatusCodes": map[string]any{"Items": []any{403}, "Quantity": 1}},
		},
		"array members": {
			"Id":               "Group",
			"Members":          []any{map[string]any{"OriginId": "Origin1"}},
			"FailoverCriteria": map[string]any{"StatusCodes": []any{404}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			config["OriginGroups"] = map[string]any{"Items": []any{group}, "Quantity": 1}
			distribution := parseDistributionConfig(t, config)
			if len(distribution.OriginGroups) != 1 || len(distribution.OriginGroups[0].Members) != 1 {
				t.Fatalf("origin groups = %+v", distribution.OriginGroups)
			}
		})
	}

	config := baseDistributionConfig()
	config["OriginGroups"] = map[string]any{"Items": []any{
		map[string]any{"Id": "Group", "Members": []any{map[string]any{"OriginId": "Missing"}}},
	}, "Quantity": 1}
	distribution := parseDistributionConfig(t, config)
	if !strings.Contains(strings.Join(distribution.OriginGroups[0].Refusals, "\n"), "Missing") &&
		!strings.Contains(strings.Join(distribution.Refusals, "\n"), "Missing") {
		t.Fatalf("a group with a missing member must be refused: %+v", distribution)
	}
}

func TestPolicyReferenceFailures(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"missing custom policy":  func(b map[string]any) { b["OriginRequestPolicyId"] = map[string]any{"Ref": "Missing"} },
		"unknown managed policy": func(b map[string]any) { b["CachePolicyId"] = "00000000-0000-0000-0000-000000000000" },
		"wrong policy kind": func(b map[string]any) {
			b["OriginRequestPolicyId"] = map[string]any{"Ref": "CachePolicy"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			config := baseDistributionConfig()
			mutate(mustMap(t, config["DefaultCacheBehavior"], "DefaultCacheBehavior"))
			resources := map[string]Resource{
				"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON(t, map[string]any{"DistributionConfig": config})},
				"CachePolicy":  {Type: typeCachePolicy, Properties: mustJSON(t, map[string]any{"CachePolicyConfig": map[string]any{}})},
			}
			topology, err := ParseTemplates([]Template{{Stack: "TestStack", Resources: resources}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if topology.Distributions[0].Servable() {
				t.Fatalf("distribution must be refused: %+v", topology.Distributions[0])
			}
		})
	}
}

func mustMap(t *testing.T, value any, label string) map[string]any {
	t.Helper()
	typed, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object: %T", label, value)
	}
	return typed
}

func mustSlice(t *testing.T, value any, label string) []any {
	t.Helper()
	typed, ok := value.([]any)
	if !ok {
		t.Fatalf("%s is not a list: %T", label, value)
	}
	return typed
}
