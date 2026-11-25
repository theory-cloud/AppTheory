package naming

import (
	"encoding/json"
	"strings"
	"testing"
)

func labContext() Context {
	return Context{
		Namespace: "theorycloud",
		App:       "autheory",
		Stage:     "lab",
		Account:   "998115851393",
		Region:    "us-east-1",
	}
}

func TestValidateContextGrammar(t *testing.T) {
	valid := labContext()
	if err := ValidateContext(valid); err != nil {
		t.Fatalf("valid context rejected: %v", err)
	}
	cases := map[string]Context{
		"app":       {App: "Autheory", Stage: "lab", Account: "998115851393", Region: "us-east-1"},
		"stage":     {App: "autheory", Stage: "Lab", Account: "998115851393", Region: "us-east-1"},
		"account":   {App: "autheory", Stage: "lab", Account: "99811585", Region: "us-east-1"},
		"region":    {App: "autheory", Stage: "lab", Account: "998115851393", Region: "useast1"},
		"namespace": {Namespace: "TheoryCloud", App: "autheory", Stage: "lab", Account: "998115851393", Region: "us-east-1"},
	}
	for want, ctx := range cases {
		if err := ValidateContext(ctx); err == nil || err.Error() != want {
			t.Fatalf("context %+v: want %q, got %v", ctx, want, err)
		}
	}
}

func TestPhysicalNamePerType(t *testing.T) {
	ctx := labContext()
	logicals := map[string]string{
		"s3_bucket":                "audit-events",
		"s3_vector_bucket":         "vectors",
		"s3_vector_index":          "vectors",
		"dynamodb_table":           "events",
		"lambda_function":          "api",
		"sqs_queue":                "jobs",
		"sns_topic":                "alerts",
		"secret":                   "stripe",
		"ssm_parameter":            "config",
		"kms_alias":                "data",
		"event_bus":                "bus",
		"event_rule":               "rule",
		"schedule":                 "nightly",
		"alarm":                    "errors",
		"dashboard":                "ops",
		"iam_role":                 "runtime",
		"iam_managed_policy":       "runtime",
		"state_machine":            "flow",
		"codebuild_project":        "build",
		"api_rest":                 "main",
		"api_http":                 "main",
		"log_delivery_source":      "cdn",
		"log_delivery_destination": "cdn",
		"log_group":                "logs/runtime/api",
	}
	for resourceType, logical := range logicals {
		composed, err := PhysicalName(ctx, resourceType, logical, nil, nil)
		if err != nil {
			t.Fatalf("%s: %v", resourceType, err)
		}
		if composed.Name == "" {
			t.Fatalf("%s: empty name", resourceType)
		}
		if resourceType == "s3_bucket" && composed.BucketNamespace != "account-regional" {
			t.Fatalf("s3_bucket: bucket namespace %q", composed.BucketNamespace)
		}
	}
}

func TestS3AccountRegionalPrefix(t *testing.T) {
	composed, err := PhysicalName(labContext(), "s3_bucket", "audit-events", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if composed.BucketNamePrefix != "autheory-lab-audit-events" {
		t.Fatalf("prefix %q", composed.BucketNamePrefix)
	}
	if composed.Name != "autheory-lab-audit-events-998115851393-us-east-1-an" {
		t.Fatalf("name %q", composed.Name)
	}
}

func TestOverBudgetShortensOnlyDashNames(t *testing.T) {
	ctx := labContext()
	ctx.App = "theory-mcp-server"
	ctx.Account = "191637461429"
	composed, err := PhysicalName(ctx, "lambda_function", "namespace-vending/request-claim-handler-version-two", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if composed.Name != "theory-mcp-server-lab-namespace-vending-request-claim-h-5mcmmerw" {
		t.Fatalf("shortened name %q", composed.Name)
	}
	if len(composed.Name) > 64 {
		t.Fatalf("shortened name over limit: %d", len(composed.Name))
	}
}

func TestLegacyProfileRequiresPins(t *testing.T) {
	ctx := labContext()
	ctx.Stage = "live"
	ctx.NamingProfile = NamingProfileLegacy
	if _, err := PhysicalName(ctx, "dynamodb_table", "events", nil, nil); err == nil {
		t.Fatal("legacy profile without a pin must fail")
	}
	composed, err := PhysicalName(ctx, "dynamodb_table", "events", map[string]string{
		"dynamodb_table:events": "autheory-autheory-live-events",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if composed.Name != "autheory-autheory-live-events" || !composed.Pinned {
		t.Fatalf("pin not used: %+v", composed)
	}
}

func TestGeneratedEntriesOnlyUnderLegacy(t *testing.T) {
	legacy := labContext()
	legacy.Stage = "live"
	legacy.NamingProfile = NamingProfileLegacy

	composed, err := PhysicalName(legacy, "s3_bucket", "audit-events", nil, []string{"s3_bucket:audit-events"})
	if err != nil {
		t.Fatal(err)
	}
	if !composed.Generated || composed.Name != "" || composed.Pinned {
		t.Fatalf("generated entry result %+v", composed)
	}

	if _, err := PhysicalName(labContext(), "s3_bucket", "audit-events", nil, []string{"s3_bucket:audit-events"}); err == nil {
		t.Fatal("generated entry under derived must fail")
	}
	if _, err := PhysicalName(
		legacy,
		"dynamodb_table",
		"events",
		map[string]string{"dynamodb_table:events": "autheory-autheory-live-events"},
		[]string{"dynamodb_table:events"},
	); err == nil {
		t.Fatal("a resource with both a pin and a generated entry must fail")
	}
	if _, err := PhysicalName(legacy, "s3_bucket", "audit-events", nil, []string{"s3_bucket:hosted-auth-assets"}); err == nil {
		t.Fatal("a generated entry for another resource must not satisfy this one")
	}
}

func TestGeneratedAPINameIsRejected(t *testing.T) {
	legacy := labContext()
	legacy.Stage = "live"
	legacy.NamingProfile = NamingProfileLegacy
	for _, resourceType := range []string{"api_rest", "api_http", "api_websocket"} {
		key := resourceType + ":main"
		_, err := PhysicalName(legacy, resourceType, "main", nil, []string{key})
		if err == nil {
			t.Fatalf("%s: a generated API name must fail", resourceType)
		}
		if !strings.Contains(err.Error(), "API name takes a pin") {
			t.Fatalf("%s: unexpected error %q", resourceType, err)
		}
	}
}

func TestPinWinsUnderDerived(t *testing.T) {
	composed, err := PhysicalName(
		labContext(),
		"dynamodb_table",
		"events",
		map[string]string{"dynamodb_table:events": "autheory-lab-events"},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if composed.Name != "autheory-lab-events" || !composed.Pinned {
		t.Fatalf("pin did not take precedence under derived: %+v", composed)
	}
}

func TestEmptyNamespaceIsRejectedThroughJSON(t *testing.T) {
	var explicit Context
	if err := json.Unmarshal([]byte(`{"namespace":"","app":"autheory","stage":"lab","account":"998115851393","region":"us-east-1"}`), &explicit); err != nil {
		t.Fatal(err)
	}
	if err := ValidateContext(explicit); err == nil || err.Error() != "namespace" {
		t.Fatalf("explicit empty namespace must be rejected, got %v", err)
	}
	var absent Context
	if err := json.Unmarshal([]byte(`{"app":"autheory","stage":"lab","account":"998115851393","region":"us-east-1"}`), &absent); err != nil {
		t.Fatal(err)
	}
	if err := ValidateContext(absent); err != nil {
		t.Fatalf("absent namespace must default: %v", err)
	}
	if prefix := LogSourcePrefix(absent); !strings.HasPrefix(prefix, "theorycloud_theorycloud_") {
		t.Fatalf("default namespace prefix %q", prefix)
	}
}

func TestCharsetIsAnchored(t *testing.T) {
	if matchesCharset(`[a-z]`, "abc!") {
		t.Fatal("charset must apply to the whole name, not a prefix")
	}
	if !matchesCharset(`[a-z0-9-]`, "autheory-lab-audit-events") {
		t.Fatal("valid name rejected")
	}
}

func TestDuplicateSelectorsAreIgnored(t *testing.T) {
	rules := Rules{
		Include: []string{"logs/runtime/*", "logs/runtime/*"},
		Exclude: []string{"logs/runtime/debug/*", "logs/runtime/debug/*"},
	}
	policy, err := CompilePolicy(labContext(), rules)
	if err != nil {
		t.Fatal(err)
	}
	if len(policy.Statement[1].Resource) != 1 || len(policy.Statement[2].Resource) != 1 {
		t.Fatalf("duplicate selectors must not duplicate resources: %+v", policy.Statement)
	}
	single := Rules{
		Include: []string{"logs/runtime/*"},
		Exclude: []string{"logs/runtime/debug/*"},
	}
	if RuleVersion(rules) != RuleVersion(single) {
		t.Fatal("duplicate selectors must not change the rule version")
	}
	preview, err := PreviewBuild(rules, []string{"logs/runtime/api"})
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Future.Include) != 1 || len(preview.Future.Exclude) != 1 {
		t.Fatalf("preview future must be a set: %+v", preview.Future)
	}
}

func TestWebSocketAPIName(t *testing.T) {
	ctx := labContext()
	ctx.App = "theory-mcp-server"
	ctx.Account = "191637461429"
	composed, err := PhysicalName(ctx, "api_websocket", "agent-sessions", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if composed.Name != "theory-mcp-server-lab-agent-sessions" {
		t.Fatalf("api_websocket name %q", composed.Name)
	}
}

func TestPreviewRejectsInvalidSelector(t *testing.T) {
	if _, err := PreviewBuild(Rules{Include: []string{"logs/run*time"}}, []string{"logs/runtime/api"}); err == nil {
		t.Fatal("preview must reject an invalid selector like compilation")
	}
	if _, err := ManifestBuild(Rules{Include: []string{"logs/run*time"}}, []string{"logs/runtime/api"}); err == nil {
		t.Fatal("manifest must reject an invalid selector like compilation")
	}
}

func TestLogGroupName(t *testing.T) {
	name, err := LogGroupName(labContext(), "logs/runtime/api")
	if err != nil {
		t.Fatal(err)
	}
	if name != "theorycloud_theorycloud_autheory_lab_logs_runtime_api" {
		t.Fatalf("log group %q", name)
	}
	if _, err := LogGroupName(labContext(), "runtime/api"); err == nil {
		t.Fatal("logical outside logs/ must fail")
	}
}

func TestCompilePolicyShape(t *testing.T) {
	policy, err := CompilePolicy(labContext(), Rules{
		Include: []string{"logs/runtime/*"},
		Exclude: []string{"logs/runtime/debug/*"},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"DescribeLogGroups", "StartQuery", "StartLiveTail"} {
		if strings.Contains(string(raw), banned) {
			t.Fatalf("policy grants %s: %s", banned, raw)
		}
	}
	if len(policy.Statement) != 3 || policy.Statement[2].Effect != "Deny" {
		t.Fatalf("unexpected statement shape: %+v", policy.Statement)
	}
}

func TestPreviewAndManifest(t *testing.T) {
	sources := []string{"logs/runtime/api", "logs/runtime/debug/fulfillment", "logs/access/api/main"}
	rules := Rules{Include: []string{"logs/runtime/*"}, Exclude: []string{"logs/runtime/debug/*"}}
	preview, err := PreviewBuild(rules, sources)
	if err != nil {
		t.Fatal(err)
	}
	if preview.RuleVersion != "ccfcb6ec1e50" {
		t.Fatalf("rule version %q", preview.RuleVersion)
	}
	if len(preview.MatchedNow) != 1 || preview.MatchedNow[0] != "logs/runtime/api" {
		t.Fatalf("matched_now %v", preview.MatchedNow)
	}
	manifest, err := ManifestBuild(rules, sources)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "not_matched_now") {
		t.Fatalf("manifest leaks private inventory: %s", raw)
	}
}

func TestKeeperDecisionFailsClosed(t *testing.T) {
	rules := &Rules{Include: []string{"logs/runtime/*"}, Exclude: []string{"logs/runtime/debug/*"}}
	cases := []struct {
		logical   string
		awsResult string
		want      string
	}{
		{"logs/runtime/api", "events", KeeperEvents},
		{"logs/runtime/api", "empty", KeeperAllowedNoEvents},
		{"logs/runtime/api", "not_found", KeeperAllowedNoEvents},
		{"logs/runtime/api", "denied", KeeperNotShared},
		{"logs/runtime/api", "unreachable", KeeperNotShared},
		{"logs/access/api/main", "events", KeeperNotShared},
	}
	for _, tc := range cases {
		if got := KeeperDecision(rules, tc.logical, tc.awsResult); got != tc.want {
			t.Fatalf("%s/%s: want %s, got %s", tc.logical, tc.awsResult, tc.want, got)
		}
	}
	if got := KeeperDecision(nil, "logs/runtime/api", "events"); got != KeeperNotShared {
		t.Fatalf("missing manifest must answer not_shared, got %s", got)
	}
}
