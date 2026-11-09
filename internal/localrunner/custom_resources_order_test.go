package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

// customResourceTemplate builds a Custom:: resource whose service token is the
// given Lambda function.
func customResourceTemplate(function string, dependsOn any, extra map[string]any) map[string]any {
	properties := map[string]any{
		"ServiceToken": map[string]any{"Fn::GetAtt": []any{function, "Arn"}},
	}
	for key, value := range extra {
		properties[key] = value
	}
	resource := map[string]any{"Type": "Custom::Probe", "Properties": properties}
	if dependsOn != nil {
		resource["DependsOn"] = dependsOn
	}
	return resource
}

func servedFunction() map[string]any {
	return withAsset(lambdaFunction(nil), "asset.deadbeef")
}

// TestTemplateOrderHonorsDependsOnThroughANonCustomResource pins X6b on the
// TMS shape: the resource whose logical id sorts first (Activate) must run
// after Ensure through an explicit DependsOn chain that passes through an SES
// receipt rule.
func TestTemplateOrderHonorsDependsOnThroughANonCustomResource(t *testing.T) {
	resources := map[string]any{
		"Fn":                                servedFunction(),
		"ActivateEmailBridgeReceiptRuleSet": customResourceTemplate("Fn", "EmailBridgeReceiptRule", nil),
		"EnsureEmailBridgeReceiptRuleSet":   customResourceTemplate("Fn", nil, nil),
		"EmailBridgeReceiptRule": map[string]any{
			"Type":       "AWS::SES::ReceiptRule",
			"DependsOn":  "EnsureEmailBridgeReceiptRuleSet",
			"Properties": map[string]any{"RuleSetName": "email-bridge"},
		},
		"Unrelated": customResourceTemplate("Fn", nil, nil),
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	ordered := dependencyOrder(spec.CustomResources)
	ids := make([]string, 0, len(ordered))
	for _, resource := range ordered {
		ids = append(ids, resource.LogicalID)
	}
	want := []string{"EnsureEmailBridgeReceiptRuleSet", "ActivateEmailBridgeReceiptRuleSet", "Unrelated"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("invocation order = %v, want %v", ids, want)
	}
}

// TestTemplateOrderUsesImplicitRefsTransitively covers the implicit edge a Ref
// creates through a resource that is not itself a custom resource, and the
// logical-id tie-break for independent resources.
func TestTemplateOrderUsesImplicitRefsTransitively(t *testing.T) {
	resources := map[string]any{
		"Fn":    servedFunction(),
		"Alpha": customResourceTemplate("Fn", nil, nil),
		"Zeta":  customResourceTemplate("Fn", nil, nil),
		"Topic": map[string]any{
			"Type":       "AWS::SNS::Topic",
			"Properties": map[string]any{"DisplayName": map[string]any{"Ref": "Alpha"}},
		},
		"Beta": customResourceTemplate("Fn", nil, map[string]any{
			"Handle": map[string]any{"Ref": "Topic"},
		}),
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	ordered := dependencyOrder(spec.CustomResources)
	ids := make([]string, 0, len(ordered))
	for _, resource := range ordered {
		ids = append(ids, resource.LogicalID)
	}
	// Alpha precedes Beta through Topic; Alpha precedes Zeta only because the
	// logical id breaks the tie.
	want := []string{"Alpha", "Beta", "Zeta"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("invocation order = %v, want %v", ids, want)
	}
}

// TestTemplateOrderCycleFailsClosed pins the named failure for a cyclic
// dependency graph.
func TestTemplateOrderCycleFailsClosed(t *testing.T) {
	resources := map[string]any{
		"Fn": servedFunction(),
		"A":  customResourceTemplate("Fn", "B", nil),
		"B":  customResourceTemplate("Fn", "A", nil),
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	if _, err := deriveAssembly(t, dir); err == nil ||
		!strings.Contains(err.Error(), "has a cycle") ||
		!strings.Contains(err.Error(), "A -> B -> A") {
		t.Fatalf("a cyclic template = %v, want a named cycle error", err)
	}
}

// TestTemplateDependsOnAcceptsAStringOrAList covers both CloudFormation shapes.
func TestTemplateDependsOnAcceptsAStringOrAList(t *testing.T) {
	if got := templateDependsOn(json.RawMessage(`"B"`)); len(got) != 1 || got[0] != "B" {
		t.Fatalf("a string DependsOn = %v", got)
	}
	if got := templateDependsOn(json.RawMessage(`["B","C"]`)); len(got) != 2 || got[0] != "B" || got[1] != "C" {
		t.Fatalf("a list DependsOn = %v", got)
	}
	if got := templateDependsOn(json.RawMessage(`42`)); got != nil {
		t.Fatalf("a malformed DependsOn = %v, want none", got)
	}
}
