package localcloudfront

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestForwardingParserErrors(t *testing.T) {
	cases := []string{
		`[]`,
		`{"HeaderBehavior":42}`,
		`{"Headers":"x"}`,
		`{"Unknown":true}`,
		`{"HeaderBehavior":"invalid"}`,
	}
	for _, raw := range cases {
		if _, err := parseHeaderForwarding(json.RawMessage(raw), true); err == nil {
			t.Fatalf("parseHeaderForwarding(%s) must fail", raw)
		}
	}
	if _, err := parseHeaderForwarding(json.RawMessage(`{"HeaderBehavior":"allViewer"}`), false); err == nil {
		t.Fatal("allViewer must be invalid for a cache policy")
	}
	for _, raw := range []string{`[]`, `{"CookieBehavior":42}`, `{"Cookies":"x"}`, `{"Unknown":true}`, `{"CookieBehavior":"invalid"}`} {
		if _, err := parseCookieForwarding(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseCookieForwarding(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`[]`, `{"QueryStringBehavior":42}`, `{"QueryStrings":"x"}`, `{"Unknown":true}`, `{"QueryStringBehavior":"invalid"}`} {
		if _, err := parseQueryForwarding(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseQueryForwarding(%s) must fail", raw)
		}
	}
	if !validMode(ForwardAll) || validMode("invalid") {
		t.Fatal("validMode is wrong")
	}
	if got := normalizeName("X-Keep", false); got != "x-keep" {
		t.Fatalf("normalizeName = %q", got)
	}
	if got := normalizeName("X-Keep", true); got != "X-Keep" {
		t.Fatalf("normalizeName case-sensitive = %q", got)
	}
}

func TestCachePolicyParserErrors(t *testing.T) {
	policy := &Policy{}
	for _, raw := range []string{
		`[]`,
		`{"ParametersInCacheKeyAndForwardedToOrigin":[]}`,
		`{"ParametersInCacheKeyAndForwardedToOrigin":{"HeadersConfig":[]}}`,
		`{"ParametersInCacheKeyAndForwardedToOrigin":{"CookiesConfig":[]}}`,
		`{"ParametersInCacheKeyAndForwardedToOrigin":{"QueryStringsConfig":[]}}`,
	} {
		if _, err := parseCachePolicyConfig(json.RawMessage(raw), policy); err == nil {
			t.Fatalf("parseCachePolicyConfig(%s) must fail", raw)
		}
	}
	if _, err := parseCachePolicyConfig(json.RawMessage(`{"Name":"p"}`), policy); err != nil {
		t.Fatalf("valid cache policy failed: %v", err)
	}
}

func TestOriginRequestPolicyParserErrors(t *testing.T) {
	policy := &Policy{}
	for _, raw := range []string{
		`[]`,
		`{"HeadersConfig":[]}`,
		`{"CookiesConfig":[]}`,
		`{"QueryStringsConfig":[]}`,
	} {
		if _, err := parseOriginRequestPolicyConfig(json.RawMessage(raw), policy); err == nil {
			t.Fatalf("parseOriginRequestPolicyConfig(%s) must fail", raw)
		}
	}
	if _, err := parseOriginRequestPolicyConfig(json.RawMessage(`{"Name":"p"}`), policy); err != nil {
		t.Fatalf("valid origin policy failed: %v", err)
	}
}

func TestResponseHeadersPolicyParserErrors(t *testing.T) {
	policy := &Policy{}
	for _, raw := range []string{
		`[]`,
		`{"CorsConfig":[]}`,
		`{"CustomHeadersConfig":[]}`,
		`{"RemoveHeadersConfig":[]}`,
		`{"SecurityHeadersConfig":[]}`,
	} {
		if _, err := parseResponseHeadersPolicyConfig(json.RawMessage(raw), policy); err == nil {
			t.Fatalf("parseResponseHeadersPolicyConfig(%s) must fail", raw)
		}
	}
	if _, err := parseResponseHeadersPolicyConfig(json.RawMessage(`{"Name":"p"}`), policy); err != nil {
		t.Fatalf("valid response policy failed: %v", err)
	}
}

func TestNestedResponsePolicyParserErrors(t *testing.T) {
	for _, raw := range []string{
		`[]`,
		`{"AccessControlAllowCredentials":42}`,
		`{"AccessControlAllowHeaders":42}`,
		`{"AccessControlAllowMethods":42}`,
		`{"AccessControlAllowOrigins":42}`,
		`{"AccessControlExposeHeaders":42}`,
		`{"AccessControlMaxAgeSec":"x"}`,
		`{"OriginOverride":42}`,
		`{"Unknown":true}`,
	} {
		if _, err := parseCORSConfig(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseCORSConfig(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{"Items":[42]}`,
		`{"Items":[{"Value":"v"}]}`,
		`{"Items":[{"Header":"X","Unknown":true}]}`,
		`{"Items":[{"Header":"X","Value":42}]}`,
		`{"Items":[{"Header":"X","Override":42}]}`,
		`{"Unknown":true}`,
	} {
		if _, err := parseCustomHeaders(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseCustomHeaders(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{"Items":[42]}`,
		`{"Items":[{}]}`,
		`{"Items":[{"Header":42}]}`,
		`{"Unknown":true}`,
	} {
		if _, err := parseRemoveHeaders(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseRemoveHeaders(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{"ContentSecurityPolicy":[]}`,
		`{"ContentTypeOptions":[]}`,
		`{"FrameOptions":[]}`,
		`{"ReferrerPolicy":[]}`,
		`{"StrictTransportSecurity":[]}`,
		`{"XSSProtection":[]}`,
		`{"Unknown":true}`,
	} {
		if _, err := parseSecurityHeaders(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseSecurityHeaders(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"Override":42}`,
	} {
		if _, err := parseContentTypeOptions(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseContentTypeOptions(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"Value":"x","Override":42}`, `{"ContentSecurityPolicy":42}`, `{"ContentSecurityPolicy":"x","Unknown":true}`,
	} {
		if _, err := parseOverrideString(json.RawMessage(raw), "CSP", "ContentSecurityPolicy"); err == nil {
			t.Fatalf("parseOverrideString(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"FrameOption":42}`, `{"Override":42}`, `{"FrameOption":"NOPE"}`,
	} {
		if _, err := parseFrameOptions(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseFrameOptions(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"ReferrerPolicy":42}`, `{"Override":42}`,
	} {
		if _, err := parseReferrerPolicy(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseReferrerPolicy(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"AccessControlMaxAgeSec":"x"}`, `{"IncludeSubdomains":42}`, `{"Preload":42}`, `{"Override":42}`,
	} {
		if _, err := parseStrictTransportSecurity(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseStrictTransportSecurity(%s) must fail", raw)
		}
	}
	for _, raw := range []string{
		`[]`, `{"Other":true}`, `{"ModeBlock":42}`, `{"Override":42}`, `{"Protection":42}`, `{"ReportUri":42}`,
	} {
		if _, err := parseXSSProtection(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseXSSProtection(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`42`, `{"Items":42}`, `{"Unknown":true}`} {
		if _, err := parseStringItems(json.RawMessage(raw)); err == nil {
			t.Fatalf("parseStringItems(%s) must fail", raw)
		}
	}
}

func TestOriginParserErrors(t *testing.T) {
	for _, raw := range []string{`[]`, `{"OriginProtocolPolicy":42}`, `{"OriginSSLProtocols":42}`, `{"HTTPPort":"x"}`, `{"HTTPSPort":"x"}`, `{"OriginKeepaliveTimeout":"x"}`, `{"OriginReadTimeout":"x"}`, `{"Unknown":true}`} {
		if _, err := parseCustomOrigin(json.RawMessage(raw), "D", 0); err == nil {
			t.Fatalf("parseCustomOrigin(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`[]`, `{"OriginAccessIdentity":42}`, `{"Unknown":true}`} {
		if _, err := parseS3Origin(json.RawMessage(raw), "D", 0); err == nil {
			t.Fatalf("parseS3Origin(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`42`, `[{"Unknown":true}]`, `[{"HeaderName":42}]`, `[{"HeaderValue":42}]`, `[{}]`} {
		if _, problem := parseOriginCustomHeaders(json.RawMessage(raw)); problem == "" {
			t.Fatalf("parseOriginCustomHeaders(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`[]`, `{"Unknown":true}`, `{"Items":42}`} {
		if _, err := parseOriginGroups(json.RawMessage(raw), "D"); err == nil {
			t.Fatalf("parseOriginGroups(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`42`} {
		if _, err := parseOriginGroup(json.RawMessage(raw), "D", 0); err == nil {
			t.Fatalf("parseOriginGroup(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`42`, `{"Items":42}`, `[{}]`} {
		if _, problem := parseOriginGroupMembers(json.RawMessage(raw)); problem == "" {
			t.Fatalf("parseOriginGroupMembers(%s) must fail", raw)
		}
	}
	for _, raw := range []string{`42`, `{"StatusCodes":42}`, `{"StatusCodes":{"Items":42}}`} {
		if _, problem := parseFailoverCriteria(json.RawMessage(raw)); problem == "" {
			t.Fatalf("parseFailoverCriteria(%s) must fail", raw)
		}
	}
}

func TestFunctionParserErrors(t *testing.T) {
	cases := []map[string]any{
		{"FunctionCode": 42},
		{"FunctionCode": "x", "FunctionConfig": []any{}},
		{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": 42}},
		{"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20, "Comment": 42}},
	}
	for _, properties := range cases {
		index := &resourceIndex{byStack: map[string]map[string]Resource{"S": {}}, stackNames: []string{"S"}}
		_, err := parseFunction("S", "Fn", Resource{Type: typeCloudFrontFunction, Properties: mustJSON(t, properties)}, index)
		if err == nil {
			t.Fatalf("parseFunction(%v) must fail", properties)
		}
	}
}

func TestDistributionParserErrors(t *testing.T) {
	index := &resourceIndex{byStack: map[string]map[string]Resource{"S": {}}, stackNames: []string{"S"}}
	topology := &Topology{functionsByID: map[string]*Function{}, policiesByID: map[string]*Policy{}}
	cases := []map[string]any{
		{"DistributionConfig": 42},
		{"DistributionConfig": map[string]any{"Aliases": 42}},
		{"DistributionConfig": map[string]any{"Comment": 42}},
		{"DistributionConfig": map[string]any{"DefaultRootObject": 42}},
		{"DistributionConfig": map[string]any{"Enabled": 42}},
		{"DistributionConfig": map[string]any{"Staging": 42}},
		{"DistributionConfig": map[string]any{"Origins": 42}},
		{"DistributionConfig": map[string]any{"OriginGroups": 42}},
		{"DistributionConfig": map[string]any{"CacheBehaviors": 42}},
		{"DistributionConfig": map[string]any{"DefaultCacheBehavior": 42}},
	}
	for _, properties := range cases {
		if _, err := parseDistribution("S", "D", Resource{Type: typeCloudFrontDistribution, Properties: mustJSON(t, properties)}, index, topology); err == nil {
			t.Fatalf("parseDistribution(%v) must fail", properties)
		}
	}
	if _, err := ParseTemplates([]Template{{Stack: "S", Resources: map[string]Resource{
		"D": {Type: typeCloudFrontDistribution, Properties: json.RawMessage(`{"Other":1}`)},
	}}}); err == nil {
		t.Fatal("a distribution without DistributionConfig must fail")
	}
}

func TestBehaviorParserErrors(t *testing.T) {
	index := &resourceIndex{byStack: map[string]map[string]Resource{"S": {}}, stackNames: []string{"S"}}
	topology := &Topology{functionsByID: map[string]*Function{}, policiesByID: map[string]*Policy{}}
	cases := []string{
		`[]`,
		`{"PathPattern":42}`,
		`{"TargetOriginId":42}`,
		`{"AllowedMethods":42}`,
		`{"ViewerProtocolPolicy":42}`,
		`{"FunctionAssociations":42}`,
		`{"Compress":42}`,
		`{"SmoothStreaming":42}`,
		`{"FunctionAssociations":42}`,
	}
	for _, raw := range cases {
		if _, err := parseBehavior(json.RawMessage(raw), "*", "S", index, topology, "D", true); err == nil {
			t.Fatalf("parseBehavior(%s) must fail", raw)
		}
	}
	if _, err := parseBehaviors(json.RawMessage(`42`), "S", index, topology, "D"); err == nil {
		t.Fatal("parseBehaviors must fail a non-list")
	}
	if err := parseFunctionAssociations(json.RawMessage(`42`), &Behavior{}, "S", index, "D"); err == nil {
		t.Fatal("parseFunctionAssociations must fail a non-list")
	}
	if err := parseFunctionAssociations(json.RawMessage(`[42]`), &Behavior{}, "S", index, "D"); err == nil {
		t.Fatal("parseFunctionAssociations must fail a non-object item")
	}
}

func TestOriginAccessControlParserErrors(t *testing.T) {
	index := &resourceIndex{byStack: map[string]map[string]Resource{"S": {}}, stackNames: []string{"S"}}
	if _, err := parseOriginAccessControl("S", "OAC", Resource{Type: typeOriginAccessControl, Properties: json.RawMessage(`[]`)}, index); err == nil {
		t.Fatal("a non-object Properties must fail")
	}
	if _, err := parseOriginAccessControl("S", "OAC", Resource{Type: typeOriginAccessControl, Properties: json.RawMessage(`{"OriginAccessControlConfig":[]}`)}, index); err == nil {
		t.Fatal("a non-object config must fail")
	}
	oac, err := parseOriginAccessControl("S", "OAC", Resource{Type: typeOriginAccessControl, Properties: json.RawMessage(`{"OriginAccessControlConfig":{"OriginAccessControlOriginType":"s3","SigningBehavior":"always","SigningProtocol":"sigv4"}}`)}, index)
	if err != nil || oac.OriginType != "s3" {
		t.Fatalf("OAC = %+v %v", oac, err)
	}
}

func TestReferenceResolutionErrors(t *testing.T) {
	index := &resourceIndex{
		byStack: map[string]map[string]Resource{"S": {
			"Bucket": {Type: typeS3Bucket},
			"Url":    {Type: typeFunctionURL},
			"Fn":     {Type: typeCloudFrontFunction},
			"Policy": {Type: typeCachePolicy},
		}},
		stackNames: []string{"S"},
	}
	for _, raw := range []string{
		`42`,
		`{"Ref":"Missing"}`,
		`{"Fn::GetAtt":["Missing","Arn"]}`,
		`{"Fn::GetAtt":"Bucket"}`,
		`{"Fn::Sub":"x"}`,
	} {
		if _, ok := resolveResourceRef(json.RawMessage(raw), "S", index); ok {
			t.Fatalf("resolveResourceRef(%s) must fail", raw)
		}
	}
	if _, problem := resolvePolicyRef(json.RawMessage(`{"Ref":"Missing"}`), PolicyCache, "S", index); problem == "" {
		t.Fatal("missing policy must fail")
	}
	if _, problem := resolvePolicyRef(json.RawMessage(`{"Fn::Sub":"x"}`), PolicyCache, "S", index); problem == "" {
		t.Fatal("unresolved policy must fail")
	}
	if _, ok := resolveFunctionRef(json.RawMessage(`{"Fn::GetAtt":["Missing","FunctionARN"]}`), "S", index); ok {
		t.Fatal("missing function must fail")
	}
	if _, ok := resolveFunctionRef(json.RawMessage(`{"Fn::GetAtt":["Fn","Arn"]}`), "S", index); ok {
		t.Fatal("wrong function attribute must fail")
	}
	if _, ok := resolveFunctionRef(json.RawMessage(`42`), "S", index); ok {
		t.Fatal("literal function ARN must fail")
	}
	for _, raw := range []string{
		`{"Fn::GetAtt":["Url","Other"]}`,
		`{"Fn::Select":[1,{"Fn::Split":["/",{"Fn::GetAtt":["Url","FunctionUrl"]}]}]}`,
		`{"Fn::Select":[2,{"Fn::Split":["|",{"Fn::GetAtt":["Url","FunctionUrl"]}]}]}`,
		`{"Fn::Select":[2,{"Fn::Split":["/",42]}]}`,
		`{"Fn::Join":["",[]]}`,
	} {
		domain, err := resolveOriginDomain(json.RawMessage(raw), "S", index)
		if err != nil {
			t.Fatalf("resolveOriginDomain(%s): %v", raw, err)
		}
		if domain.Kind != refUnresolved {
			t.Fatalf("resolveOriginDomain(%s) = %+v, want unresolved", raw, domain)
		}
	}
	domain, err := resolveOriginDomain(json.RawMessage(`{"Fn::Select":[2,{"Fn::Split":["/",{"Fn::GetAtt":["Url","FunctionUrl"]}]}]}`), "S", index)
	if err != nil || domain.Kind != refFunctionURL {
		t.Fatalf("Function URL domain = %+v %v", domain, err)
	}
	domain, err = resolveOriginDomain(json.RawMessage(`{"Fn::GetAtt":["Bucket","RegionalDomainName"]}`), "S", index)
	if err != nil || domain.Kind != refS3Bucket {
		t.Fatalf("bucket domain = %+v %v", domain, err)
	}
	if domain, err := resolveOriginDomain(json.RawMessage(`""`), "S", index); err != nil || domain.Kind != refUnresolved {
		t.Fatalf("empty domain = %+v %v", domain, err)
	}
}

func TestTemplateHelpers(t *testing.T) {
	index := newResourceIndex([]Template{{Stack: "A"}, {Stack: "B"}})
	if got := index.qualified("A", "X"); got != "A/X" {
		t.Fatalf("qualified = %q", got)
	}
	single := newResourceIndex([]Template{{Stack: "A"}})
	if got := single.qualified("A", "X"); got != "X" {
		t.Fatalf("single qualified = %q", got)
	}
	if _, err := decodeProperties(Resource{Properties: json.RawMessage(`[]`)}); err == nil {
		t.Fatal("a non-object Properties must fail")
	}
	if properties, err := decodeProperties(Resource{}); err != nil || len(properties) != 0 {
		t.Fatalf("empty Properties = %v %v", properties, err)
	}
}

func TestSmallPolicyHelpers(t *testing.T) {
	if policyCache(nil) != nil || policyOriginRequest(nil) != nil {
		t.Fatal("nil behavior must yield nil policies")
	}
	if policyCache(&Behavior{}) != nil || policyOriginRequest(&Behavior{}) != nil {
		t.Fatal("behavior without policies must yield nil")
	}
	header := httpHeaderWithHopByHop()
	removeHopByHop(header)
	if header.Get("Connection") != "" || header.Get("X-Keep") != "yes" {
		t.Fatalf("removeHopByHop = %v", header)
	}
	if !isHopByHopHeader("Transfer-Encoding") || isHopByHopHeader("X-Keep") {
		t.Fatal("isHopByHopHeader is wrong")
	}
	if eventTypeOf(nil) != "" {
		t.Fatal("eventTypeOf(nil) must be empty")
	}
	if got := localDistributionID(nil); got != "LOCAL" {
		t.Fatalf("localDistributionID(nil) = %q", got)
	}
	if len(newGatewayRequestID()) == 0 {
		t.Fatal("request id is empty")
	}
}

func httpHeaderWithHopByHop() http.Header {
	header := http.Header{}
	header.Set("Connection", "keep-alive")
	header.Set("X-Keep", "yes")
	return header
}

func TestReportReasonCoversInventory(t *testing.T) {
	for _, inventory := range PropertyInventory() {
		for key, disposition := range inventory {
			switch disposition {
			case Reported:
				if strings.TrimSpace(reportReason(key)) == "" {
					t.Fatalf("reportReason(%q) is empty", key)
				}
			case Refused:
				if strings.TrimSpace(refusalReason(key)) == "" {
					t.Fatalf("refusalReason(%q) is empty", key)
				}
			}
		}
	}
}
