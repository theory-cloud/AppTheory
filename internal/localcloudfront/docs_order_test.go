package localcloudfront

import (
	"os"
	"strings"
	"testing"
)

// TestDocumentedCloudFrontPhaseOrder pins the phase order in the reference
// docs to the order the gateway executes. A docs edit that moves a phase, or a
// code edit that reorders the calls, fails here.
func TestDocumentedCloudFrontPhaseOrder(t *testing.T) {
	document := "../../docs/examples/local-runner.md"
	raw, err := os.ReadFile(document) //nolint:gosec // checked-in documentation path
	if err != nil {
		t.Fatalf("read %s: %v", document, err)
	}
	section := markdownSection(t, string(raw), "## CloudFront distributions")
	markers := []string{
		"cache behavior",
		"viewer-request function",
		"AllowedMethods",
		"origin request policy",
		"origin receives",
		"viewer-response function",
		"response headers policy",
	}
	assertDocumentedOrder(t, document, section, markers)

	if !strings.Contains(section, "not a\nCloudFront emulator: no caching, no edge network, no TLS") &&
		!strings.Contains(section, "not a CloudFront emulator: no caching, no edge network, no TLS") {
		t.Fatalf("%s: the CloudFront section must carry the fidelity statement", document)
	}
	if !strings.Contains(section, "CloudFront does not document the relative order") {
		t.Fatalf("%s: the AllowedMethods phase must state that CloudFront does not document the order", document)
	}
	assertDocumentedOrder(t, document, section, []string{
		"**S3.**", "**Function URL.**", "**Origin group.**", "**Other origins.**",
	})
	if strings.Contains(section, "not wired until A5b") {
		t.Fatalf("%s: the CloudFront section still claims origins are not wired", document)
	}

	gatewaySource, err := os.ReadFile("gateway.go") //nolint:gosec // checked-in source path
	if err != nil {
		t.Fatalf("read gateway.go: %v", err)
	}
	body := goFunctionBody(t, string(gatewaySource), "func (g *Gateway) ServeHTTP(")
	assertDocumentedOrder(t, "gateway.go", body, []string{
		"BehaviorForURI(",
		"ViewerRequestFunction",
		"methodAllowed(",
		"originRequest(",
		"originImplementation.Fetch(",
		"ViewerResponseFunction",
		"applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &final)",
	})
}

func TestReferenceDocumentsEveryPinnedManagedPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../docs/reference/local-runner-configuration.md") //nolint:gosec // checked-in documentation path
	if err != nil {
		t.Fatalf("read reference: %v", err)
	}
	text := string(raw)
	for _, kind := range []PolicyKind{PolicyCache, PolicyOriginRequest, PolicyResponseHeaders} {
		for _, id := range ManagedPolicyIDs(kind) {
			if !strings.Contains(text, id) {
				t.Fatalf("reference does not document managed %s %s", kind, id)
			}
		}
	}
	for _, property := range []string{"WebACLId", "TrustedKeyGroups", "LambdaFunctionAssociations", "KeyValueStoreAssociations", "ForwardedValues"} {
		if !strings.Contains(text, property) {
			t.Fatalf("reference does not document refused property %s", property)
		}
	}
}

func TestReferenceDocumentsTheOriginContract(t *testing.T) {
	raw, err := os.ReadFile("../../docs/reference/local-runner-configuration.md") //nolint:gosec // checked-in documentation path
	if err != nil {
		t.Fatalf("read reference: %v", err)
	}
	text := string(raw)
	for _, needle := range []string{
		"`Range`",
		"`SuppressS3ResponseOverrides`",
		"FailoverCriteria",
		"GET and HEAD always fail over",
		"`CachedMethods` lists OPTIONS",
		"s3:ListBucket",
		"AWS_IAM",
		"buffered by the RIE",
		"response-content-type",
		"AllViewerExceptHostHeader",
		"Custom::CDKBucketDeployment",
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("reference does not document the origin contract item %q", needle)
		}
	}
	for _, document := range []string{
		"../../docs/examples/local-runner.md",
		"../../docs/reference/local-runner-configuration.md",
		"../../docs/examples/local-harness.md",
	} {
		raw, err := os.ReadFile(document) //nolint:gosec // checked-in documentation path
		if err != nil {
			t.Fatalf("read %s: %v", document, err)
		}
		if strings.Contains(string(raw), "not wired until A5b") {
			t.Fatalf("%s still claims an origin is not wired", document)
		}
	}
}

func markdownSection(t *testing.T, document, heading string) string {
	t.Helper()
	start := strings.Index(document, heading)
	if start < 0 {
		t.Fatalf("document has no %q", heading)
	}
	rest := document[start+len(heading):]
	if end := strings.Index(rest, "\n## "); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

func assertDocumentedOrder(t *testing.T, path, text string, markers []string) {
	t.Helper()
	previous := -1
	for _, marker := range markers {
		index := strings.Index(text, marker)
		if index < 0 {
			t.Fatalf("%s: no marker %q", path, marker)
		}
		if index <= previous {
			t.Fatalf("%s: marker %q is out of order", path, marker)
		}
		previous = index
	}
}

func goFunctionBody(t *testing.T, source, signature string) string {
	t.Helper()
	start := strings.Index(source, signature)
	if start < 0 {
		t.Fatalf("source has no %q", signature)
	}
	body := source[start+len(signature):]
	if end := strings.Index(body, "\nfunc "); end >= 0 {
		body = body[:end]
	}
	return body
}
