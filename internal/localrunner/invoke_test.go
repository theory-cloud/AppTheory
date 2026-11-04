package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodeInvokeResult(t *testing.T) {
	proxy := decodeInvokeResult([]byte(`{"statusCode":201,"headers":{"x-a":"b"},"body":"{\"ok\":true}"}`))
	if !proxy.Proxy || proxy.StatusCode != 201 || proxy.Headers["x-a"][0] != "b" || proxy.Body != `{"ok":true}` {
		t.Fatalf("unexpected proxy result: %+v", proxy)
	}
	raw := decodeInvokeResult([]byte(`{"batchItemFailures":[]}`))
	if raw.Proxy || string(raw.Raw) != `{"batchItemFailures":[]}` {
		t.Fatalf("unexpected raw result: %+v", raw)
	}
	handler := decodeInvokeResult([]byte(`{"errorType":"Runtime.Error","errorMessage":"boom"}`))
	if handler.Proxy || !strings.Contains(handler.HandlerError, "boom") {
		t.Fatalf("unexpected handler error result: %+v", handler)
	}
	text := decodeInvokeResult([]byte(`plain text`))
	if text.Proxy || text.RawText != "plain text" {
		t.Fatalf("unexpected text result: %+v", text)
	}
}

func TestNormalizeHandlerSpec(t *testing.T) {
	base := t.TempDir()
	spec := &HandlerSpec{CodeDir: base, Runtime: "provided.al2023", Handler: "bootstrap"}
	if err := normalizeHandlerSpec(spec); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if spec.Architecture != archARM64 || spec.MemoryMB != 128 || spec.Timeout != 3 {
		t.Fatalf("unexpected defaults: %+v", spec)
	}
	if err := normalizeHandlerSpec(&HandlerSpec{CodeDir: base, Runtime: "java21", Handler: "x"}); err == nil {
		t.Fatal("an unsupported runtime must fail")
	}
	if err := normalizeHandlerSpec(&HandlerSpec{CodeDir: filepath.Join(base, "missing"), Runtime: "nodejs24.x", Handler: "x"}); err == nil {
		t.Fatal("a missing code directory must fail")
	}
	if err := normalizeHandlerSpec(&HandlerSpec{CodeDir: base, Runtime: "nodejs24.x"}); err == nil {
		t.Fatal("a missing handler must fail")
	}
}

func TestInvokeTargetErrors(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}}
	spec := &Spec{Functions: []FunctionSpec{
		{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: "/tmp"},
		{LogicalID: "BadCode", CodeProblem: "no code"},
		{LogicalID: "Layered", LayerCount: 1, LayerProblem: "layer reference names an external ARN"},
		{LogicalID: "Limit", UnresolvedMemorySize: true},
	}}
	for _, id := range []string{"", "Missing", "BadCode", "Layered", "Limit"} {
		if _, _, err := runner.invokeTarget(spec, id); err == nil {
			t.Fatalf("invokeTarget(%q) must fail", id)
		}
	}
	if id, _, err := runner.invokeTarget(spec, "Fn"); err != nil || id != "Fn" {
		t.Fatalf("valid target: %q %v", id, err)
	}
	handlerRunner := &Runner{options: Options{Handler: &HandlerSpec{CodeDir: "/tmp", Runtime: "provided.al2023", Handler: "bootstrap"}}}
	handlerSpec := &Spec{Functions: []FunctionSpec{{LogicalID: "Handler", Runtime: "provided.al2023"}}}
	if id, _, err := handlerRunner.invokeTarget(handlerSpec, ""); err != nil || id != "Handler" {
		t.Fatalf("handler target: %q %v", id, err)
	}
	if _, _, err := handlerRunner.invokeTarget(handlerSpec, "Other"); err == nil {
		t.Fatal("handler mode must reject an unknown target")
	}
}

func TestStreamInvocationsKeepsTheContainerWarm(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		writer.Header().Set("content-type", "application/json")
		if _, err := fmt.Fprintf(writer, `{"statusCode":200,"body":"{\"call\":%d}"}`, calls); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()
	address, ok := server.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected listener address type %T", server.Listener.Addr())
	}
	port := address.Port
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn"}, Port: port}
	input := strings.NewReader("{\"a\":1}\n{\"a\":2}\n")
	var output bytes.Buffer
	runner := &Runner{invokers: map[string]*FunctionProcess{"Fn": process}}
	if err := runner.streamInvocations(context.Background(), process, input, &output); err != nil {
		t.Fatalf("stream: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 || calls != 2 {
		t.Fatalf("expected two invocations, got %d lines and %d calls", len(lines), calls)
	}
	var first InvokeResult
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if !first.Proxy || first.StatusCode != 200 || !strings.Contains(first.Body, `"call":1`) {
		t.Fatalf("unexpected first result: %+v", first)
	}
}

func TestStreamInvocationsRejectsAnInvalidEvent(t *testing.T) {
	runner := &Runner{}
	process := &FunctionProcess{}
	if err := runner.streamInvocations(context.Background(), process, strings.NewReader("not-json\n"), &bytes.Buffer{}); err == nil {
		t.Fatal("an invalid event must fail before invoking")
	}
}

func TestInvokeSpecHandlerMode(t *testing.T) {
	base := testBase(t)
	if err := os.WriteFile(filepath.Join(base, "bootstrap"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(Options{
		ScratchDir: filepath.Join(base, "scratch"),
		Handler:    &HandlerSpec{CodeDir: base, Runtime: "provided.al2023", Handler: "bootstrap"},
	})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	spec, err := runner.invokeSpec(context.Background())
	if err != nil {
		t.Fatalf("invoke spec: %v", err)
	}
	if len(spec.Functions) != 1 || spec.Functions[0].LogicalID != "Handler" {
		t.Fatalf("unexpected handler spec: %+v", spec.Functions)
	}
	if _, _, err := runner.invokeTarget(spec, "Other"); err == nil {
		t.Fatal("handler mode must reject an unknown target")
	}
}
