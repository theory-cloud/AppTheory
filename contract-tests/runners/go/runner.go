package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sort"
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
	} else {
		fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
	}

	expected := f.Expect.Response
	expected.Headers = canonicalizeHeaders(expected.Headers)
	b, _ := json.MarshalIndent(expected, "", "  ")
	fmt.Fprintf(os.Stderr, "  expected: %s\n", string(b))
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
