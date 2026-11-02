package localrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// documentedRunStep is one numbered step in the "How it works" section. Calls
// lists the runner methods that implement it, in order.
type documentedRunStep struct {
	doc   string
	calls []string
}

// TestDocumentedRunStepOrderMatchesTheRunner pins docs/examples/local-runner.md
// to the call order in Run and prepareInvoke. Environment resolution consumes
// the values provisioning created, so a docs edit that moves it ahead of the
// backends, or a code edit that reverses them, fails here.
func TestDocumentedRunStepOrderMatchesTheRunner(t *testing.T) {
	steps := []documentedRunStep{
		{doc: "**Synthesize.**", calls: []string{"r.Plan("}},
		{doc: "**Derive.**"},
		{doc: "**Resolve images.**", calls: []string{"r.resolveImages("}},
		{doc: "**Prepare the run workspace.**", calls: []string{"r.prepareScratch(", "r.docker.CreateNetwork("}},
		{doc: "**Start backends.**", calls: []string{"r.startBackends("}},
		{doc: "**Provision resources.**", calls: []string{"r.provisionResources("}},
		{doc: "**Resolve environment references.**", calls: []string{"r.resolveEnvironment("}},
		{doc: "**Preflight.**", calls: []string{"r.Preflight("}},
		{doc: "**Run.**", calls: []string{"r.startFunctions("}},
		{doc: "**Serve or invoke.**", calls: []string{"r.startServers(", "r.serve("}},
	}

	document := filepath.Join("..", "..", "docs", "examples", "local-runner.md")
	section := documentedSection(t, document, "## How it works")
	markers := make([]string, 0, len(steps))
	for _, step := range steps {
		markers = append(markers, step.doc)
	}
	assertInOrder(t, document, section, "documented step", markers)

	invokeSection := documentedSection(t, document, "## Invoking one function")
	assertInOrder(t, document, invokeSection, "documented invoke step", []string{
		"images,", "scratch,", "network,", "backends,", "provisioning,", "environment resolution", "preflight",
	})

	runBody := goFunctionBody(t, "runner.go", "func (r *Runner) Run(ctx context.Context) error {")
	assertInOrder(t, "runner.go", runBody, "Run call", flattenedCalls(steps))

	invokeBody := goFunctionBody(t, "invoke.go", "func (r *Runner) prepareInvoke(ctx context.Context, spec *Spec, functionID string) error {")
	assertInOrder(t, "invoke.go", invokeBody, "prepareInvoke call", []string{
		"r.resolveImages(",
		"r.prepareScratch(",
		"r.docker.CreateNetwork(",
		"r.startBackends(",
		"r.provisionResources(",
		"r.resolveEnvironment(",
		"r.Preflight(",
	})
	runInvokeBody := goFunctionBody(t, "invoke.go", "func (r *Runner) RunInvoke(ctx context.Context, functionID string, in io.Reader, out io.Writer) error {")
	assertInOrder(t, "invoke.go", runInvokeBody, "RunInvoke call", []string{
		"r.prepareInvoke(",
		"r.startFunction(",
		"r.streamInvocations(",
	})
}

func flattenedCalls(steps []documentedRunStep) []string {
	var calls []string
	for _, step := range steps {
		calls = append(calls, step.calls...)
	}
	return calls
}

func assertInOrder(t *testing.T, path, text, kind string, markers []string) {
	t.Helper()
	previous := -1
	for _, marker := range markers {
		index := strings.Index(text, marker)
		if index < 0 {
			t.Fatalf("%s: no %s %q", path, kind, marker)
		}
		if index <= previous {
			t.Fatalf("%s: %s %q is out of order", path, kind, marker)
		}
		previous = index
	}
}

func goFunctionBody(t *testing.T, path, signature string) string {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // checked-in source path
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	text := string(raw)
	start := strings.Index(text, signature)
	if start < 0 {
		t.Fatalf("%s has no %q", path, signature)
	}
	body := text[start+len(signature):]
	if end := strings.Index(body, "\nfunc "); end >= 0 {
		body = body[:end]
	}
	return body
}
