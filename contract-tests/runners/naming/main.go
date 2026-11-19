// Command naming runs the theorycloud_resource_naming.v0.1 conformance fixtures
// against the Go naming package.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"

	"github.com/theory-cloud/apptheory/v7/pkg/naming"
)

const contract = naming.Contract

type fixture struct {
	Contract  string          `json:"contract"`
	FixtureID string          `json:"fixture_id"`
	Scenario  json.RawMessage `json:"scenario"`
	Expected  json.RawMessage `json:"expected"`
	Proof     struct {
		DoesNotProve []string `json:"does_not_prove"`
	} `json:"proof"`
}

type scenario struct {
	Type         string            `json:"type"`
	Context      *naming.Context   `json:"context"`
	ResourceType string            `json:"resource_type"`
	Logical      string            `json:"logical"`
	Pins         map[string]string `json:"pins"`
	Rules        *naming.Rules     `json:"rules"`
	Sources      []string          `json:"sources"`
	AWSResult    *string           `json:"aws_result"`
}

func main() {
	root := flag.String("fixtures", filepath.Join("contract-tests", "fixtures", "resource-naming", "v0.1"), "fixtures root")
	flag.Parse()

	ok, total, failures := run(*root)
	for _, failure := range failures {
		fmt.Fprintln(os.Stderr, failure)
	}
	if ok != total {
		fmt.Fprintf(os.Stderr, "resource-naming(go): FAIL (%d/%d passed)\n", ok, total)
		os.Exit(1)
	}
	fmt.Printf("resource-naming(go): PASS (%d fixtures)\n", total)
}

func run(root string) (int, int, []string) {
	passed, total := 0, 0
	var failures []string
	for _, family := range []string{"valid", "invalid"} {
		paths, err := filepath.Glob(filepath.Join(root, family, "*.json"))
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		sort.Strings(paths)
		for _, path := range paths {
			total++
			reasons := checkFile(path)
			if family == "invalid" {
				if len(reasons) > 0 {
					passed++
					fmt.Printf("PASS %s/%s (rejected)\n", family, filepath.Base(path))
					continue
				}
				fmt.Printf("FAIL %s/%s\n", family, filepath.Base(path))
				failures = append(failures, fmt.Sprintf("  %s/%s: invalid fixture passed", family, filepath.Base(path)))
				continue
			}
			if len(reasons) == 0 {
				passed++
				fmt.Printf("PASS %s/%s\n", family, filepath.Base(path))
				continue
			}
			fmt.Printf("FAIL %s/%s\n", family, filepath.Base(path))
			for _, reason := range reasons {
				failures = append(failures, fmt.Sprintf("  %s/%s: %s", family, filepath.Base(path), reason))
			}
		}
	}
	return passed, total, failures
}

func checkFile(path string) []string {
	//nolint:gosec // Fixture files are discovered from the repo-owned fixtures directory.
	raw, err := os.ReadFile(path)
	if err != nil {
		return []string{err.Error()}
	}
	var fx fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		return []string{fmt.Sprintf("parse: %v", err)}
	}
	reasons := fixtureReasons(fx)
	var expected any
	if err := json.Unmarshal(fx.Expected, &expected); err != nil {
		return append(reasons, fmt.Sprintf("parse expected: %v", err))
	}
	got, gotErr := evaluate(fx.Scenario)
	return append(reasons, comparisonReasons(got, gotErr, expected)...)
}

func fixtureReasons(fx fixture) []string {
	var reasons []string
	if fx.Contract != contract {
		reasons = append(reasons, "contract id")
	}
	declared := map[string]bool{}
	for _, value := range fx.Proof.DoesNotProve {
		declared[value] = true
	}
	for _, required := range []string{"deployment_proof", "journey_proof", "aws_behaviour_proof"} { //nolint:misspell // Fixture field value.
		if !declared[required] {
			reasons = append(reasons, "missing proof disclaimer "+required)
		}
	}
	return reasons
}

func comparisonReasons(got any, gotErr error, expected any) []string {
	expectsError := false
	if object, ok := expected.(map[string]any); ok {
		if message, ok := object["error"]; ok {
			expectsError = message != nil && message != ""
		}
	}
	switch {
	case gotErr != nil && !expectsError:
		return []string{"contract rejects: " + gotErr.Error()}
	case gotErr == nil && expectsError:
		return []string{"fixture expects rejection but contract accepts"}
	case gotErr == nil && !reflect.DeepEqual(got, expected):
		return []string{fmt.Sprintf("expected %s != required %s", mustJSON(expected), mustJSON(got))}
	default:
		return nil
	}
}

func evaluate(raw json.RawMessage) (any, error) {
	var sc scenario
	if err := json.Unmarshal(raw, &sc); err != nil {
		return nil, err
	}
	switch sc.Type {
	case "name":
		return evaluateName(sc)
	case "log_group":
		return evaluateLogGroup(sc)
	case "compile":
		policy, err := naming.CompilePolicy(contextOf(sc), rulesOf(sc.Rules))
		if err != nil {
			return nil, err
		}
		return toGeneric(policy), nil
	case "preview":
		preview, err := naming.PreviewBuild(rulesOf(sc.Rules), sc.Sources)
		if err != nil {
			return nil, err
		}
		return toGeneric(preview), nil
	case "manifest":
		manifest, err := naming.ManifestBuild(rulesOf(sc.Rules), sc.Sources)
		if err != nil {
			return nil, err
		}
		return toGeneric(manifest), nil
	case "keeper":
		awsResult := ""
		if sc.AWSResult != nil {
			awsResult = *sc.AWSResult
		}
		return map[string]any{"answer": naming.KeeperDecision(sc.Rules, sc.Logical, awsResult)}, nil
	case "visible":
		return map[string]any{"visible": naming.Visible(rulesOf(sc.Rules), sc.Logical)}, nil
	default:
		return nil, fmt.Errorf("unknown scenario type %s", sc.Type)
	}
}

func evaluateName(sc scenario) (any, error) {
	if sc.Context == nil {
		return nil, fmt.Errorf("name scenario requires a context")
	}
	composed, err := naming.PhysicalName(*sc.Context, sc.ResourceType, sc.Logical, sc.Pins)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"name": composed.Name}
	if composed.BucketNamePrefix != "" {
		out["bucket_name_prefix"] = composed.BucketNamePrefix
	}
	if composed.BucketNamespace != "" {
		out["bucket_namespace"] = composed.BucketNamespace
	}
	if composed.Pinned {
		out["pinned"] = true
	}
	return out, nil
}

func evaluateLogGroup(sc scenario) (any, error) {
	if sc.Context == nil {
		return nil, fmt.Errorf("log_group scenario requires a context")
	}
	if err := naming.ValidateContext(*sc.Context); err != nil {
		return nil, err
	}
	name, err := naming.LogGroupName(*sc.Context, sc.Logical)
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": name}, nil
}

func contextOf(sc scenario) naming.Context {
	if sc.Context == nil {
		return naming.Context{}
	}
	return *sc.Context
}

func rulesOf(rules *naming.Rules) naming.Rules {
	if rules == nil {
		return naming.Rules{}
	}
	return *rules
}

func toGeneric(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return value
	}
	return out
}

func mustJSON(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(raw)
}
