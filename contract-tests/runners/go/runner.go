package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
)

type actualResponseForCompare struct {
	Status   int                 `json:"status"`
	Headers  map[string][]string `json:"headers"`
	Cookies  []string            `json:"cookies"`
	Body     *FixtureBody        `json:"body,omitempty"`
	BodyJSON any                 `json:"body_json,omitempty"`
	IsBase64 bool                `json:"is_base64"`
}

func runFixture(f Fixture) error {
	switch strings.ToLower(strings.TrimSpace(f.Tier)) {
	case "p0":
		return runFixtureP0(f)
	case "p1":
		return runFixtureP1(f)
	case "p2":
		return runFixtureP2(f)
	default:
		return runFixtureLegacy(f)
	}
}

func runFixtureLegacy(f Fixture) error {
	app, err := newFixtureApp(f.Setup, f.Tier)
	if err != nil {
		return fmt.Errorf("setup app: %w", err)
	}

	req, err := canonicalizeRequest(f.Input.Request)
	if err != nil {
		return fmt.Errorf("canonicalize request: %w", err)
	}
	req.RemainingMS = f.Input.Context.RemainingMS

	actual := app.handle(req)
	expected := f.Expect.Response

	expectedHeaders := canonicalizeHeaders(expected.Headers)
	actual.Headers = canonicalizeHeaders(actual.Headers)

	if expected.Status != actual.Status {
		return fmt.Errorf("status: expected %d, got %d", expected.Status, actual.Status)
	}
	if expected.IsBase64 != actual.IsBase64 {
		return fmt.Errorf("is_base64: expected %v, got %v", expected.IsBase64, actual.IsBase64)
	}
	if !equalStringSlices(expected.Cookies, actual.Cookies) {
		return fmt.Errorf("cookies mismatch")
	}
	if !equalHeaders(expectedHeaders, actual.Headers) {
		return fmt.Errorf("headers mismatch")
	}

	if len(expected.BodyJSON) > 0 {
		var expectedJSON any
		if err := json.Unmarshal(expected.BodyJSON, &expectedJSON); err != nil {
			return fmt.Errorf("parse expected body_json: %w", err)
		}
		var actualJSON any
		if err := json.Unmarshal(actual.Body, &actualJSON); err != nil {
			return fmt.Errorf("parse actual response body as json: %w", err)
		}
		if !jsonEqual(expectedJSON, actualJSON) {
			return fmt.Errorf("body_json mismatch")
		}
		if !reflect.DeepEqual(f.Expect.Logs, app.logs) {
			return fmt.Errorf("logs mismatch")
		}
		if !reflect.DeepEqual(f.Expect.Metrics, app.metrics) {
			return fmt.Errorf("metrics mismatch")
		}
		if !reflect.DeepEqual(f.Expect.Spans, app.spans) {
			return fmt.Errorf("spans mismatch")
		}
		return nil
	}

	var expectedBodyBytes []byte
	if expected.Body == nil {
		expectedBodyBytes = nil
	} else {
		expectedBodyBytes, err = decodeFixtureBody(*expected.Body)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}
	if !equalBytes(expectedBodyBytes, actual.Body) {
		return fmt.Errorf("body mismatch")
	}

	if !reflect.DeepEqual(f.Expect.Logs, app.logs) {
		return fmt.Errorf("logs mismatch")
	}
	if !reflect.DeepEqual(f.Expect.Metrics, app.metrics) {
		return fmt.Errorf("metrics mismatch")
	}
	if !reflect.DeepEqual(f.Expect.Spans, app.spans) {
		return fmt.Errorf("spans mismatch")
	}
	return nil
}

func jsonEqual(a, b any) bool {
	ab, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bb, err := json.Marshal(b)
	if err != nil {
		return false
	}
	return string(ab) == string(bb)
}

func printFailure(f Fixture, err error) {
	fmt.Fprintf(os.Stderr, "FAIL %s — %s\n", f.ID, f.Name)
	fmt.Fprintf(os.Stderr, "  %v\n", err)

	if strings.EqualFold(strings.TrimSpace(f.Tier), "p0") {
		printFailureP0(f)
		return
	}

	app, appErr := newFixtureApp(f.Setup, f.Tier)
	req, reqErr := canonicalizeRequest(f.Input.Request)
	req.RemainingMS = f.Input.Context.RemainingMS
	if appErr == nil && reqErr == nil {
		actual := app.handle(req)
		actual.Headers = canonicalizeHeaders(actual.Headers)

		debug := actualResponseForCompare{
			Status:   actual.Status,
			Headers:  actual.Headers,
			Cookies:  actual.Cookies,
			IsBase64: actual.IsBase64,
		}

		if len(f.Expect.Response.BodyJSON) > 0 {
			var actualJSON any
			if json.Unmarshal(actual.Body, &actualJSON) == nil {
				debug.BodyJSON = actualJSON
			} else {
				debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
			}
		} else {
			debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
		}

		b, _ := json.MarshalIndent(debug, "", "  ")
		fmt.Fprintf(os.Stderr, "  got: %s\n", string(b))

		logs, _ := json.MarshalIndent(app.logs, "", "  ")
		metrics, _ := json.MarshalIndent(app.metrics, "", "  ")
		spans, _ := json.MarshalIndent(app.spans, "", "  ")
		fmt.Fprintf(os.Stderr, "  got.logs: %s\n", string(logs))
		fmt.Fprintf(os.Stderr, "  got.metrics: %s\n", string(metrics))
		fmt.Fprintf(os.Stderr, "  got.spans: %s\n", string(spans))
	} else {
		fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
	}

	expected := f.Expect.Response
	expected.Headers = canonicalizeHeaders(expected.Headers)
	b, _ := json.MarshalIndent(expected, "", "  ")
	fmt.Fprintf(os.Stderr, "  expected: %s\n", string(b))

	logs, _ := json.MarshalIndent(f.Expect.Logs, "", "  ")
	metrics, _ := json.MarshalIndent(f.Expect.Metrics, "", "  ")
	spans, _ := json.MarshalIndent(f.Expect.Spans, "", "  ")
	fmt.Fprintf(os.Stderr, "  expected.logs: %s\n", string(logs))
	fmt.Fprintf(os.Stderr, "  expected.metrics: %s\n", string(metrics))
	fmt.Fprintf(os.Stderr, "  expected.spans: %s\n", string(spans))
}

func summarizeFailures(failed []Fixture) {
	if len(failed) == 0 {
		return
	}
	sort.Slice(failed, func(i, j int) bool { return failed[i].ID < failed[j].ID })
	fmt.Fprintln(os.Stderr, "\nFailed fixtures:")
	for _, f := range failed {
		fmt.Fprintf(os.Stderr, "- %s\n", f.ID)
	}
}
