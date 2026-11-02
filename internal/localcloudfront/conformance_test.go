package localcloudfront

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"testing"
)

// TestGeneratedFunctionConformance runs every CloudFront Function in the
// construct snapshots through the executor. The cases follow the same
// expectations cdk/test/constructs.test.cjs asserts on the generated code:
// original URI/host headers, the ssg-isr index rewrite and passthrough
// prefixes, the SPA index rewrite, and the viewer-response request-id echo.
func TestGeneratedFunctionConformance(t *testing.T) {
	functions := collectSnapshotFunctions(t)
	if len(functions) == 0 {
		t.Fatal("no generated CloudFront Functions found in the snapshots")
	}
	executor := NewExecutor()
	covered := 0
	for code, ids := range functions {
		t.Run(functionTestName(ids), func(t *testing.T) {
			function := &Function{LogicalID: ids[0], Runtime: runtimeJS20, Code: code}
			switch {
			case strings.Contains(code, "spaPrefixes"):
				covered++
				runSPAConformance(t, executor, function, code)
			case strings.Contains(code, "event.response") && strings.Contains(code, "x-request-id"):
				covered++
				runViewerResponseConformance(t, executor, function)
			case strings.Contains(code, "'ssg-isr' === 'ssg-isr'"):
				covered++
				runSSRIndexConformance(t, executor, function, code)
			case strings.Contains(code, "x-apptheory-original-uri"):
				covered++
				runSSRContextConformance(t, executor, function, code)
			default:
				t.Fatalf("generated function %v is not classified by the conformance table", ids)
			}
			runCodeAssertions(t, code, ids)
		})
	}
	if covered == 0 {
		t.Fatal("no snapshot function was covered")
	}
}

func collectSnapshotFunctions(t *testing.T) map[string][]string {
	t.Helper()
	functions := map[string][]string{}
	for _, name := range snapshotNames(t) {
		topology := parseSnapshot(t, name)
		for _, function := range topology.Functions {
			functions[function.Code] = append(functions[function.Code], name+":"+function.LogicalID)
		}
	}
	return functions
}

func functionTestName(ids []string) string {
	if len(ids) == 0 {
		return "function"
	}
	name := ids[0]
	if index := strings.IndexByte(name, ':'); index >= 0 {
		name = name[index+1:]
	}
	return name
}

func conformanceEvent(eventType, uri string) *Event {
	return &Event{
		Version: "1.0",
		Context: EventContext{
			DistributionDomainName: "d111111abcdef8.cloudfront.net",
			DistributionID:         "EDFDVBD6EXAMPLE",
			EventType:              eventType,
			RequestID:              "conformance-request-id",
		},
		Viewer: Viewer{IP: "203.0.113.9"},
		Request: &EventRequest{
			Method:      "GET",
			URI:         uri,
			Querystring: QueryString{Values: map[string]HeaderValue{}},
			Headers: map[string]HeaderValue{
				"host": {Value: "viewer.example"},
			},
			Cookies: map[string]HeaderValue{},
		},
	}
}

func runSSRContextConformance(t *testing.T, executor *Executor, function *Function, code string) {
	t.Helper()
	base := conformanceEvent("viewer-request", "/about")
	base.Request.Headers["x-request-id"] = HeaderValue{Value: "incoming-id"}
	result, err := executor.Execute(context.Background(), function, base)
	if err != nil {
		t.Fatalf("incoming request id: %v", err)
	}
	assertRequestHeader(t, result, "x-request-id", "incoming-id")
	assertRequestHeader(t, result, "x-apptheory-original-uri", "/about")
	assertRequestHeader(t, result, "x-facetheory-original-uri", "/about")
	assertRequestHeader(t, result, "x-apptheory-original-host", "viewer.example")
	assertRequestHeader(t, result, "x-facetheory-original-host", "viewer.example")

	contextCase := conformanceEvent("viewer-request", "/from-context")
	result, err = executor.Execute(context.Background(), function, contextCase)
	if err != nil {
		t.Fatalf("context request id: %v", err)
	}
	assertRequestHeader(t, result, "x-request-id", "conformance-request-id")

	generated := conformanceEvent("viewer-request", "/generated")
	generated.Context.RequestID = ""
	result, err = executor.Execute(context.Background(), function, generated)
	if err != nil {
		t.Fatalf("generated request id: %v", err)
	}
	if !strings.HasPrefix(result.Request.Headers["x-request-id"].Value, "req_") {
		t.Fatalf("generated request id = %q", result.Request.Headers["x-request-id"].Value)
	}

	tenantHeader := conformanceEvent("viewer-request", "/tenant")
	tenantHeader.Request.Headers["x-tenant-id"] = HeaderValue{Value: "tenant"}
	tenantHeader.Request.Headers["x-facetheory-tenant"] = HeaderValue{Value: "tenant"}
	result, err = executor.Execute(context.Background(), function, tenantHeader)
	if err != nil {
		t.Fatalf("tenant header: %v", err)
	}
	if strings.Contains(code, "'x-tenant-id'") {
		if _, present := result.Request.Headers["x-tenant-id"]; present {
			t.Fatal("the generated function blocks x-tenant-id, but the executor returned it")
		}
	}
	if strings.Contains(code, "'x-facetheory-tenant'") {
		if _, present := result.Request.Headers["x-facetheory-tenant"]; present {
			t.Fatal("the generated function blocks x-facetheory-tenant, but the executor returned it")
		}
	}
}

func runSSRIndexConformance(t *testing.T, executor *Executor, function *Function, code string) {
	t.Helper()
	if !strings.Contains(code, "_facetheory/ssr-data") {
		t.Fatalf("ssg-isr function does not contain the SSR data passthrough prefix")
	}
	cases := map[string]string{
		"/about":                          "/about/index.html",
		"/about/":                         "/about/index.html",
		"/":                               "/index.html",
		"/about.html":                     "/about.html",
		"/assets/app.js":                  "/assets/app.js",
		"/_facetheory/data/home.json":     "/_facetheory/data/home.json",
		"/_facetheory/ssr-data/entry.txt": "/_facetheory/ssr-data/entry.txt",
	}
	for uri, want := range cases {
		event := conformanceEvent("viewer-request", uri)
		result, err := executor.Execute(context.Background(), function, event)
		if err != nil {
			t.Fatalf("%s: %v", uri, err)
		}
		if result.Request.URI != want {
			t.Fatalf("%s rewrote to %q, want %q", uri, result.Request.URI, want)
		}
	}
}

type spaPrefixConfig struct {
	prefix            string
	indexPath         string
	stripBeforeOrigin bool
}

var spaPrefixPattern = regexp.MustCompile(`cleanPrefix: '([^']+)'.*?stripPrefixBeforeOrigin: (true|false).*?indexPath: '([^']+)'`)

func runSPAConformance(t *testing.T, executor *Executor, function *Function, code string) {
	t.Helper()
	matches := spaPrefixPattern.FindAllStringSubmatch(code, -1)
	if len(matches) == 0 {
		t.Fatalf("SPA rewrite function has no parsable prefix config")
	}
	for _, match := range matches {
		config := spaPrefixConfig{
			prefix:            match[1] + "/",
			indexPath:         match[3],
			stripBeforeOrigin: match[2] == "true",
		}
		root := match[1]
		index := config.indexPath
		if config.stripBeforeOrigin {
			index = "/index.html"
		}
		cases := map[string]string{
			config.prefix + "dashboard": index,
			config.prefix:               index,
			config.prefix + "app.js":    config.prefix + "app.js",
			root:                        root,
			"/other":                    "/other",
		}
		if config.stripBeforeOrigin {
			cases[config.prefix+"app.js"] = "/app.js"
		}
		for uri, want := range cases {
			event := conformanceEvent("viewer-request", uri)
			result, err := executor.Execute(context.Background(), function, event)
			if err != nil {
				t.Fatalf("%s: %v", uri, err)
			}
			if result.Request.URI != want {
				t.Fatalf("%s rewrote to %q, want %q", uri, result.Request.URI, want)
			}
		}
	}
}

func runViewerResponseConformance(t *testing.T, executor *Executor, function *Function) {
	t.Helper()
	event := conformanceEvent("viewer-response", "/about")
	event.Request.Headers["x-request-id"] = HeaderValue{Value: "rid-1"}
	event.Response = &EventResponse{StatusCode: 200, Headers: map[string]HeaderValue{}, Cookies: map[string]CookieValue{}}
	result, err := executor.Execute(context.Background(), function, event)
	if err != nil {
		t.Fatalf("echo: %v", err)
	}
	if result.Response.Headers["x-request-id"].Value != "rid-1" {
		t.Fatalf("viewer-response did not echo the request id: %#v", result.Response.Headers)
	}

	event = conformanceEvent("viewer-response", "/about")
	event.Request.Headers["x-request-id"] = HeaderValue{Value: "rid-1"}
	event.Response = &EventResponse{StatusCode: 200, Headers: map[string]HeaderValue{
		"x-request-id": {Value: "origin-id"},
	}, Cookies: map[string]CookieValue{}}
	result, err = executor.Execute(context.Background(), function, event)
	if err != nil {
		t.Fatalf("preserve: %v", err)
	}
	if result.Response.Headers["x-request-id"].Value != "origin-id" {
		t.Fatalf("viewer-response replaced the origin request id: %#v", result.Response.Headers)
	}

	event = conformanceEvent("viewer-response", "/about")
	event.Context.RequestID = "context-id"
	event.Response = &EventResponse{StatusCode: 200, Headers: map[string]HeaderValue{}, Cookies: map[string]CookieValue{}}
	result, err = executor.Execute(context.Background(), function, event)
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	if result.Response.Headers["x-request-id"].Value != "context-id" {
		t.Fatalf("viewer-response did not use the context request id: %#v", result.Response.Headers)
	}
}

// runCodeAssertions mirrors the generated-function assertions in
// cdk/test/constructs.test.cjs so a code change that drops a literal fails
// here before a snapshot is accepted.
func runCodeAssertions(t *testing.T, code string, ids []string) {
	t.Helper()
	if strings.Contains(code, "spaPrefixes") {
		if !strings.Contains(code, "rewriteMode: 'spa'") {
			t.Fatalf("%v: SPA rewrite code lost the normalized spa mode", ids)
		}
		if !strings.Contains(code, "indexPath") {
			t.Fatalf("%v: SPA rewrite code lost the index path", ids)
		}
	}
	if strings.Contains(code, "x-apptheory-original-uri") {
		for _, literal := range []string{
			"x-apptheory-original-host", "x-facetheory-original-host",
			"x-apptheory-original-uri", "x-facetheory-original-uri", "x-request-id",
		} {
			if !strings.Contains(code, literal) {
				t.Fatalf("%v: viewer-request code lost %s", ids, literal)
			}
		}
	}
	if strings.Contains(code, "event.response") {
		if !strings.Contains(code, "x-request-id") {
			t.Fatalf("%v: viewer-response code lost the request-id echo", ids)
		}
	}
}

func assertRequestHeader(t *testing.T, result *FunctionResult, name, want string) {
	t.Helper()
	if result == nil || result.Request == nil {
		t.Fatalf("no request result")
	}
	if got := result.Request.Headers[name].Value; got != want {
		t.Fatalf("header %s = %q, want %q", name, got, want)
	}
}

func TestGeneratedFunctionTableIsComplete(t *testing.T) {
	functions := collectSnapshotFunctions(t)
	if len(functions) < 4 {
		t.Fatalf("expected the ssr viewer-request/response and SPA rewrite functions, found %d unique codes", len(functions))
	}
	for code, ids := range functions {
		var kind string
		switch {
		case strings.Contains(code, "spaPrefixes"):
			kind = "spa-rewrite"
		case strings.Contains(code, "event.response") && strings.Contains(code, "x-request-id"):
			kind = "viewer-response"
		case strings.Contains(code, "'ssg-isr' === 'ssg-isr'"):
			kind = "ssr-viewer-request-ssg-isr"
		default:
			kind = "ssr-viewer-request"
		}
		t.Logf("%s: %s (%d bytes) used by %s", kind, shortCodeHash(code), len(code), strings.Join(ids, ", "))
	}
}

func shortCodeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:4])
}
