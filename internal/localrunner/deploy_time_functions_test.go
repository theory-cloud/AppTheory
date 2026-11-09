package localrunner

import (
	"strings"
	"testing"
)

// TestDeployTimeClosureStartsTheProviderTarget pins X6d on the Autheory shape:
// AdminBootstrap's service token is a provider-framework handler that names
// BootstrapAdminFunction in its own environment. The AdminBootstrap custom
// resource's properties never mention that function, so only the environment
// closure can put it in the run's function set.
func TestDeployTimeClosureStartsTheProviderTarget(t *testing.T) {
	resources := map[string]any{
		"BootstrapProviderframeworkonEvent": withAsset(lambdaFunction(map[string]any{
			"Environment": map[string]any{
				"Variables": map[string]any{
					"USER_ON_EVENT_FUNCTION_ARN": map[string]any{"Fn::GetAtt": []any{"BootstrapAdminFunction", "Arn"}},
				},
			},
		}), "asset.deadbeef"),
		"BootstrapAdminFunction": servedFunction(),
		"AdminBootstrap": map[string]any{
			"Type": "Custom::Bootstrap",
			"Properties": map[string]any{
				"ServiceToken": map[string]any{"Fn::GetAtt": []any{"BootstrapProviderframeworkonEvent", "Arn"}},
				"Timestamp":    "1",
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if strings.Join(spec.DeployTimeFunctions, ",") != "BootstrapAdminFunction,BootstrapProviderframeworkonEvent" {
		t.Fatalf("deploy-time closure = %v, want the provider and its target", spec.DeployTimeFunctions)
	}
	targets := map[string]bool{}
	for _, id := range spec.RuntimeFunctions() {
		targets[id] = true
	}
	if !targets["BootstrapProviderframeworkonEvent"] || !targets["BootstrapAdminFunction"] {
		t.Fatalf("the run starts %v, want both the provider and its target", spec.RuntimeFunctions())
	}
	// The closure is transitive: a second environment edge from the target
	// reaches another function.
	resources["BootstrapAdminFunction"] = withAsset(lambdaFunction(map[string]any{
		"Environment": map[string]any{
			"Variables": map[string]any{
				"REPAIR_FUNCTION_ARN": map[string]any{"Fn::GetAtt": []any{"RepairFunction", "Arn"}},
			},
		},
	}), "asset.deadbeef")
	resources["RepairFunction"] = servedFunction()
	dir = writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err = deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive (transitive): %v", err)
	}
	if strings.Join(spec.DeployTimeFunctions, ",") != "BootstrapAdminFunction,BootstrapProviderframeworkonEvent,RepairFunction" {
		t.Fatalf("transitive closure = %v", spec.DeployTimeFunctions)
	}
}

// TestDeployTimeClosureSkipsAHandlerWithoutCode pins the fail-open edge: a
// function the closure finds but the assembly cannot start is not added to the
// run, so an unstartable handler cannot fail every existing run.
func TestDeployTimeClosureSkipsAHandlerWithoutCode(t *testing.T) {
	resources := map[string]any{
		"Provider": withAsset(lambdaFunction(map[string]any{
			"Environment": map[string]any{
				"Variables": map[string]any{
					"USER_ON_EVENT_FUNCTION_ARN": map[string]any{"Fn::GetAtt": []any{"NoCodeFunction", "Arn"}},
				},
			},
		}), "asset.deadbeef"),
		"NoCodeFunction": lambdaFunction(nil),
		"Probe": map[string]any{
			"Type": "Custom::Probe",
			"Properties": map[string]any{
				"ServiceToken": map[string]any{"Fn::GetAtt": []any{"Provider", "Arn"}},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if strings.Join(spec.DeployTimeFunctions, ",") != "NoCodeFunction,Provider" {
		t.Fatalf("deploy-time closure = %v, want the discovered function and the provider", spec.DeployTimeFunctions)
	}
	for _, id := range spec.RuntimeFunctions() {
		if id == "NoCodeFunction" {
			t.Fatal("a function without code must not be started")
		}
	}
}
