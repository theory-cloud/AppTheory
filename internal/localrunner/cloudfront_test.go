package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

func cloudFrontDistributionResources() map[string]any {
	return map[string]any{
		"Distribution": map[string]any{
			"Type": typeCloudFront,
			"Properties": map[string]any{
				"DistributionConfig": map[string]any{
					"Enabled":           true,
					"DefaultRootObject": "index.html",
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
						"TargetOriginId":          "Origin1",
						"ViewerProtocolPolicy":    "redirect-to-https",
						"AllowedMethods":          []any{"GET", "HEAD"},
						"CachePolicyId":           "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
						"OriginRequestPolicyId":   map[string]any{"Ref": "OriginPolicy"},
						"ResponseHeadersPolicyId": map[string]any{"Ref": "ResponsePolicy"},
						"FunctionAssociations": []any{
							map[string]any{
								"EventType":   "viewer-request",
								"FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}},
							},
						},
					},
				},
			},
		},
		"ViewerFn": map[string]any{
			"Type": typeCloudFrontFn,
			"Properties": map[string]any{
				"FunctionCode": `function handler(event) { return event.request; }`,
				"FunctionConfig": map[string]any{
					"Runtime": "cloudfront-js-2.0",
					"Comment": "viewer-request",
				},
			},
		},
		"OriginPolicy": map[string]any{
			"Type": "AWS::CloudFront::OriginRequestPolicy",
			"Properties": map[string]any{
				"OriginRequestPolicyConfig": map[string]any{
					"Name": "test-origin-policy",
					"HeadersConfig": map[string]any{
						"HeaderBehavior": "whitelist",
						"Headers":        []any{"x-keep"},
					},
					"CookiesConfig":      map[string]any{"CookieBehavior": "none"},
					"QueryStringsConfig": map[string]any{"QueryStringBehavior": "all"},
				},
			},
		},
		"ResponsePolicy": map[string]any{
			"Type": "AWS::CloudFront::ResponseHeadersPolicy",
			"Properties": map[string]any{
				"ResponseHeadersPolicyConfig": map[string]any{
					"Name": "test-response-policy",
					"SecurityHeadersConfig": map[string]any{
						"ContentTypeOptions": map[string]any{"Override": true},
					},
				},
			},
		},
	}
}

func TestDeriveCloudFrontDistributionIsASurface(t *testing.T) {
	dir := writeAssembly(t, cloudFrontDistributionResources())
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.CloudFront) != 1 {
		t.Fatalf("cloudFront = %d", len(spec.CloudFront))
	}
	distribution := spec.CloudFront[0]
	if !distribution.Servable() {
		t.Fatalf("distribution is refused: %v", distribution.Refusals)
	}
	if distribution.DefaultBehavior == nil || distribution.DefaultBehavior.ViewerRequestFunction != "ViewerFn" {
		t.Fatalf("default behavior = %+v", distribution.DefaultBehavior)
	}
	if len(spec.CloudFrontFunctions) != 1 || spec.CloudFrontFunctions[0].Runtime != "cloudfront-js-2.0" {
		t.Fatalf("cloudFrontFunctions = %+v", spec.CloudFrontFunctions)
	}
	if spec.cloudFrontTopology == nil {
		t.Fatal("the parsed topology is not retained for the gateway")
	}
	document, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	if !strings.Contains(string(document), `"cloudFront"`) {
		t.Fatalf("plan JSON has no cloudFront field: %s", document)
	}
	table := strings.Join(RouteTable(spec), "\n")
	for _, fragment := range []string{"cloudfront Distribution", "DEFAULT", "viewer-request=ViewerFn"} {
		if !strings.Contains(table, fragment) {
			t.Fatalf("route table missing %q:\n%s", fragment, table)
		}
	}
}

func TestDeriveCloudFrontRefusalIsReported(t *testing.T) {
	resources := cloudFrontDistributionResources()
	config := distributionConfig(t, resources)
	config["WebACLId"] = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/test"
	resources["FunctionURL"] = map[string]any{
		"Type": typeFunctionURL,
		"Properties": map[string]any{
			"AuthType":          "NONE",
			"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
		},
	}
	resources["Fn"] = map[string]any{
		"Type": typeLambdaFunction,
		"Properties": map[string]any{
			"Runtime": "nodejs24.x",
			"Handler": "index.handler",
			"Code":    map[string]any{"ZipFile": "exports.handler = async () => ({statusCode: 200});"},
		},
	}
	dir := writeAssembly(t, resources)
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive with a Function URL surface: %v", err)
	}
	if spec.CloudFront[0].Servable() {
		t.Fatal("a distribution with a WAF web ACL must be refused")
	}
	found := false
	for _, skipped := range spec.Skipped {
		if skipped.Kind == "cloudfront distribution" && strings.Contains(skipped.Reason, "WebACLId") {
			found = true
		}
	}
	if !found {
		t.Fatalf("refused distribution is not reported under skipped: %+v", spec.Skipped)
	}
}

func TestDeriveOnlyRefusedCloudFrontHasNoSurface(t *testing.T) {
	resources := cloudFrontDistributionResources()
	config := distributionConfig(t, resources)
	config["Restrictions"] = map[string]any{"GeoRestriction": map[string]any{"RestrictionType": "whitelist"}}
	dir := writeAssembly(t, resources)
	_, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err == nil {
		t.Fatal("a refused distribution with no other surface must fail")
	}
	if !strings.Contains(err.Error(), "Restrictions") {
		t.Fatalf("error does not name the refusal: %v", err)
	}
}

func TestStartServersServesCloudFrontAndRefusesOrigins(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	distribution := &localcloudfront.Distribution{
		LogicalID: "Distribution",
		Stack:     "TestStack",
		Enabled:   true,
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern:    "*",
			TargetOriginID: "Origin1",
			AllowedMethods: []string{"GET", "HEAD"},
			CachePolicy:    &localcloudfront.Policy{Kind: localcloudfront.PolicyCache, Cache: &localcloudfront.CachePolicy{}},
		},
		Origins: []*localcloudfront.DistributionOrigin{{
			ID: "Origin1", DomainName: "origin.example", Kind: localcloudfront.OriginCustom, Custom: &localcloudfront.CustomOrigin{},
		}},
	}
	spec := &Spec{
		CloudFront:         []*localcloudfront.Distribution{distribution},
		cloudFrontTopology: &localcloudfront.Topology{},
	}
	if err := runner.startServers(context.Background(), spec); err != nil {
		t.Fatalf("start servers: %v", err)
	}
	t.Cleanup(func() {
		for _, listener := range runner.listeners {
			if err := listener.Close(); err != nil {
				t.Logf("close listener: %v", err)
			}
		}
		for _, server := range runner.servers {
			if err := server.Close(); err != nil {
				t.Logf("close server: %v", err)
			}
		}
	})
	url := runner.apiURLs["Distribution"]
	if url == "" {
		t.Fatal("the distribution has no local URL")
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url+"/hello", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Logf("close response body: %v", closeErr)
		}
	}()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.StatusCode)
	}
	if !strings.Contains(string(body), "outside this machine") {
		t.Fatalf("body does not name the reason: %q", body)
	}
}

func TestSessionDescribeIncludesCloudFront(t *testing.T) {
	runner := &Runner{apiURLs: map[string]string{"Distribution": "http://127.0.0.1:1234"}}
	session := &localSession{
		runner: runner,
		spec: &Spec{CloudFront: []*localcloudfront.Distribution{{
			LogicalID: "Distribution",
			DefaultBehavior: &localcloudfront.Behavior{
				TargetOriginID: "Origin1",
			},
		}}},
	}
	described, err := session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	entries, ok := described["cloudFront"].([]map[string]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("cloudFront = %+v", described["cloudFront"])
	}
	if entries[0]["url"] != "http://127.0.0.1:1234" || entries[0]["servable"] != true {
		t.Fatalf("unexpected describe entry: %+v", entries[0])
	}
}

func TestSessionDescribeIncludesBackendEndpoints(t *testing.T) {
	runner := &Runner{
		apiURLs: map[string]string{},
		backends: map[string]backendProcess{
			"s3proxy": {HostURL: "http://127.0.0.1:9000", Endpoints: []Endpoint{{Service: "s3"}}},
		},
	}
	session := &localSession{runner: runner, spec: &Spec{}}
	described, err := session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	endpoints, ok := described["endpoints"].([]map[string]any)
	if !ok || len(endpoints) != 1 || endpoints[0]["service"] != "s3" || endpoints[0]["url"] != "http://127.0.0.1:9000" {
		t.Fatalf("endpoints = %+v", described["endpoints"])
	}
}

func mustLoadAssembly(t *testing.T, dir string) []assemblyStack {
	t.Helper()
	stacks, err := loadAssembly(dir)
	if err != nil {
		t.Fatalf("load assembly: %v", err)
	}
	return stacks
}

func distributionConfig(t *testing.T, resources map[string]any) map[string]any {
	t.Helper()
	resource, ok := resources["Distribution"].(map[string]any)
	if !ok {
		t.Fatal("fixture has no Distribution resource")
	}
	properties, ok := resource["Properties"].(map[string]any)
	if !ok {
		t.Fatal("fixture distribution has no Properties")
	}
	config, ok := properties["DistributionConfig"].(map[string]any)
	if !ok {
		t.Fatal("fixture distribution has no DistributionConfig")
	}
	return config
}
