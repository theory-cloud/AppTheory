package localrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fakeCDKScript = `#!/bin/sh
set -e
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -z "$out" ]; then
  echo "missing -o" >&2
  exit 1
fi
mkdir -p "$out/asset.deadbeef"
cat > "$out/manifest.json" <<'JSON'
{"version":"54.0.0","artifacts":{"TestStack":{"type":"aws:cloudformation:stack","properties":{"templateFile":"TestStack.template.json"}}}}
JSON
cat > "$out/TestStack.template.json" <<'JSON'
{"Resources":{"Fn":{"Type":"AWS::Lambda::Function","Metadata":{"aws:asset:path":"asset.deadbeef"},"Properties":{"Runtime":"nodejs24.x","Handler":"index.handler","Architectures":["arm64"],"MemorySize":256,"Code":{"S3Bucket":"b","S3Key":"k"}}},"Url":{"Type":"AWS::Lambda::Url","Properties":{"AuthType":"NONE","TargetFunctionArn":{"Fn::GetAtt":["Fn","Arn"]}}}}}
JSON
`

func fakeCDKApp(t *testing.T, base string) string {
	t.Helper()
	app := filepath.Join(base, "app")
	if err := os.MkdirAll(filepath.Join(app, "node_modules", ".bin"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "cdk.json"), []byte(`{"app":"node bin/app.js"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(app, "node_modules", ".bin", "cdk")
	if err := os.WriteFile(cli, []byte(fakeCDKScript), 0o700); err != nil { //nolint:gosec // the fake CDK CLI must be executable
		t.Fatal(err)
	}
	return app
}

func TestSynthRunsTheAppCDKCLI(t *testing.T) {
	base := testBase(t)
	app := fakeCDKApp(t, base)
	output := filepath.Join(base, "cdk.out")
	if err := Synth(t.Context(), SynthOptions{
		AppDir:    app,
		OutputDir: output,
		Context:   map[string]string{"lang": "go"},
	}); err != nil {
		t.Fatalf("synth: %v", err)
	}
	for _, name := range []string{"manifest.json", "TestStack.template.json", "asset.deadbeef"} {
		if _, err := os.Stat(filepath.Join(output, name)); err != nil {
			t.Fatalf("synth output missing %s: %v", name, err)
		}
	}
}

func TestSynthRejectsBadInputs(t *testing.T) {
	base := testBase(t)
	if err := Synth(t.Context(), SynthOptions{AppDir: base, OutputDir: filepath.Join(base, "out")}); err == nil ||
		!strings.Contains(err.Error(), "no cdk.json") {
		t.Fatalf("a directory without cdk.json must fail: %v", err)
	}
	app := filepath.Join(base, "app")
	if err := os.MkdirAll(app, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "cdk.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Synth(t.Context(), SynthOptions{AppDir: app, OutputDir: filepath.Join(base, "out")}); err == nil ||
		!strings.Contains(err.Error(), "npm ci") {
		t.Fatalf("a missing CDK CLI must give an actionable error: %v", err)
	}
	cli := filepath.Join(app, "node_modules", ".bin", "cdk")
	if err := os.MkdirAll(filepath.Dir(cli), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cli, []byte("#!/bin/sh\necho 'TypeError: boom' >&2\nexit 3\n"), 0o700); err != nil { //nolint:gosec // the fake CDK CLI must be executable
		t.Fatal(err)
	}
	err := Synth(t.Context(), SynthOptions{AppDir: app, OutputDir: filepath.Join(base, "out")})
	if err == nil || !strings.Contains(err.Error(), "TypeError: boom") {
		t.Fatalf("a failing synth must include the CDK output: %v", err)
	}
}

func TestSynthEnvironmentIsClean(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "operator-key")
	t.Setenv("AWS_ENDPOINT_URL", "https://dynamodb.us-east-1.amazonaws.com")
	t.Setenv("CDK_DEFAULT_ACCOUNT", "999999999999")
	t.Setenv("HTTPS_PROXY", "http://proxy.example:3128")
	env := synthEnvironment()
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"operator-key", "dynamodb.us-east-1.amazonaws.com", "999999999999", "proxy.example"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("synth environment leaked %q:\n%s", forbidden, joined)
		}
	}
	for _, required := range []string{
		"AWS_ACCESS_KEY_ID=dummy",
		"AWS_REGION=" + LocalRegion,
		"CDK_DEFAULT_ACCOUNT=" + LocalAccountID,
		"TS_NODE_TRANSPILE_ONLY=1",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("synth environment missing %q", required)
		}
	}
}

func TestCleanEnvironmentDropsRunnerOwnedNames(t *testing.T) {
	t.Setenv("DYNAMODB_ENDPOINT", "http://real")
	t.Setenv("DDB_ENDPOINT", "http://real")
	t.Setenv("APPTHEORY_KEEP_ME", "1")
	env := cleanEnvironment()
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"DYNAMODB_ENDPOINT=", "DDB_ENDPOINT="} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("clean environment kept %q", forbidden)
		}
	}
	if !strings.Contains(joined, "APPTHEORY_KEEP_ME=1") {
		t.Fatal("clean environment dropped an unrelated variable")
	}
}

func TestTailLines(t *testing.T) {
	if got := tailLines("a\nb\nc", 2); got != "b\nc" {
		t.Fatalf("unexpected tail: %q", got)
	}
	if got := tailLines("a", 5); got != "a" {
		t.Fatalf("unexpected short tail: %q", got)
	}
}

func TestPlanSynthesizesTheApp(t *testing.T) {
	base := testBase(t)
	app := fakeCDKApp(t, base)
	runner, err := NewRunner(Options{
		AppDir:      app,
		ScratchDir:  filepath.Join(base, "scratch"),
		ProfilePath: writeTestProfile(t, base),
		NamePrefix:  "test-synth",
	})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	spec, err := runner.Plan(t.Context())
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(spec.FunctionURLs) != 1 || spec.FunctionURLs[0].Function != "Fn" {
		t.Fatalf("unexpected plan: %+v", spec)
	}
	if runner.options.AssemblyDir != "" {
		t.Fatal("the runner must not rewrite the caller's assembly option")
	}
}
