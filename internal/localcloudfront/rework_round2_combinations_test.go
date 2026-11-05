package localcloudfront

import (
	"strings"
	"testing"
)

// Round-2 rework tests for CloudFront Function and Lambda@Edge combinations.

// A-R5b-R1-1: "You can't combine CloudFront Functions and Lambda@Edge in
// viewer events (viewer request and viewer response)." Every viewer cell of
// the allowed-combinations table is "Not allowed".
func TestAnyViewerEventCombinationOfCloudFrontFunctionAndLambdaEdgeIsRefused(t *testing.T) {
	distributionConfig := func(functionEvent, lambdaEvent string) map[string]any {
		return map[string]any{"DistributionConfig": map[string]any{
			"Enabled": true,
			"DefaultCacheBehavior": map[string]any{
				"PathPattern":    "*",
				"TargetOriginId": "Origin",
				"CachePolicyId":  "658327ea-f89d-4fab-a63d-7e88639e58f6",
				"FunctionAssociations": []any{map[string]any{
					"EventType": functionEvent, "FunctionARN": map[string]any{"Fn::GetAtt": []any{"ViewerFn", "FunctionARN"}},
				}},
				"LambdaFunctionAssociations": []any{map[string]any{
					"EventType": lambdaEvent, "LambdaFunctionARN": map[string]any{"Ref": "Version"},
				}},
			},
			"Origins": []any{map[string]any{
				"Id": "Origin", "DomainName": "bucket.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
			}},
		}}
	}
	resources := func(functionEvent, lambdaEvent string) map[string]Resource {
		return map[string]Resource{
			"Function": {Type: typeLambdaFunction, Properties: mustJSON2(map[string]any{"Runtime": "nodejs24.x", "Handler": "index.handler"})},
			"Version":  {Type: typeLambdaVersion, Properties: mustJSON2(map[string]any{"FunctionName": map[string]any{"Ref": "Function"}})},
			"ViewerFn": {Type: typeCloudFrontFunction, Properties: mustJSON2(map[string]any{
				"FunctionCode": "x", "FunctionConfig": map[string]any{"Runtime": runtimeJS20},
			})},
			"Distribution": {Type: typeCloudFrontDistribution, Properties: mustJSON2(distributionConfig(functionEvent, lambdaEvent))},
		}
	}
	cases := []struct {
		name          string
		functionEvent string
		lambdaEvent   string
		refused       bool
	}{
		{"same viewer request", "viewer-request", "viewer-request", true},
		{"same viewer response", "viewer-response", "viewer-response", true},
		{"function viewer response with lambda viewer request", "viewer-response", "viewer-request", true},
		{"function viewer request with lambda viewer response", "viewer-request", "viewer-response", true},
		{"function viewer request with lambda origin request", "viewer-request", "origin-request", false},
		{"function viewer response with lambda origin response", "viewer-response", "origin-response", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology, err := ParseTemplates([]Template{{
				Stack:     "TestStack",
				Resources: resources(test.functionEvent, test.lambdaEvent),
			}})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			distribution := topology.Distributions[0]
			refusals := strings.Join(distribution.Refusals, "\n")
			if !test.refused {
				if !distribution.Servable() {
					t.Fatalf("the allowed combination must be served: %s", refusals)
				}
				return
			}
			if distribution.Servable() {
				t.Fatal("the combination must be refused")
			}
			for _, needle := range []string{
				"You can't combine CloudFront Functions and Lambda@Edge in viewer events",
				test.functionEvent, test.lambdaEvent, "ViewerFn", "Version", edgeRestrictionsPage,
			} {
				if !strings.Contains(refusals, needle) {
					t.Fatalf("refusals do not contain %q: %s", needle, refusals)
				}
			}
		})
	}
}
