package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
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
	case "m1":
		return runFixtureM1(f)
	case "m2":
		return runFixtureM2(f)
	default:
		return runFixtureLegacy(f)
	}
}

func runFixtureLegacy(f Fixture) error {
	app, err := newFixtureApp(f.Setup, f.Tier)
	if err != nil {
		return fmt.Errorf("setup app: %w", err)
	}

	if f.Input.Request == nil {
		return errors.New("fixture missing input.request")
	}
	req, err := canonicalizeRequest(*f.Input.Request)
	if err != nil {
		return fmt.Errorf("canonicalize request: %w", err)
	}
	req.RemainingMS = f.Input.Context.RemainingMS

	actual := app.handle(req)
	if f.Expect.Response == nil {
		return errors.New("fixture missing expect.response")
	}
	expected := *f.Expect.Response

	actual.Headers = canonicalizeHeaders(actual.Headers)
	expectedHeaders := canonicalizeHeaders(expected.Headers)

	if err := compareLegacyResponseMeta(expected, actual, expectedHeaders); err != nil {
		return err
	}

	if err := compareLegacyResponseBody(expected, actual.Body); err != nil {
		return err
	}

	return compareLegacySideEffects(f.Expect, app.logs, app.metrics, app.spans)
}

func compareLegacyResponseMeta(expected FixtureResponse, actual CanonicalResponse, expectedHeaders map[string][]string) error {
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
	return nil
}

func compareLegacyResponseBody(expected FixtureResponse, actualBody []byte) error {
	if len(expected.BodyJSON) > 0 {
		var expectedJSON any
		if unmarshalErr := json.Unmarshal(expected.BodyJSON, &expectedJSON); unmarshalErr != nil {
			return fmt.Errorf("parse expected body_json: %w", unmarshalErr)
		}
		var actualJSON any
		if unmarshalErr := json.Unmarshal(actualBody, &actualJSON); unmarshalErr != nil {
			return fmt.Errorf("parse actual response body as json: %w", unmarshalErr)
		}
		if !jsonEqual(expectedJSON, actualJSON) {
			return fmt.Errorf("body_json mismatch")
		}
		return nil
	}

	var expectedBodyBytes []byte
	if expected.Body != nil {
		var err error
		expectedBodyBytes, err = decodeFixtureBody(*expected.Body)
		if err != nil {
			return fmt.Errorf("decode expected body: %w", err)
		}
	}
	if !equalBytes(expectedBodyBytes, actualBody) {
		return fmt.Errorf("body mismatch")
	}
	return nil
}

func compareLegacySideEffects(expected FixtureExpect, logs []FixtureLogRecord, metrics []FixtureMetricRecord, spans []FixtureSpanRecord) error {
	if !reflect.DeepEqual(expected.Logs, logs) {
		return fmt.Errorf("logs mismatch")
	}
	if !reflect.DeepEqual(expected.Metrics, metrics) {
		return fmt.Errorf("metrics mismatch")
	}
	if !reflect.DeepEqual(expected.Spans, spans) {
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
	var req CanonicalRequest
	var reqErr error
	if f.Input.Request != nil {
		req, reqErr = canonicalizeRequest(*f.Input.Request)
	} else {
		reqErr = errors.New("fixture missing input.request")
	}
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

		if f.Expect.Response != nil && len(f.Expect.Response.BodyJSON) > 0 {
			var actualJSON any
			if json.Unmarshal(actual.Body, &actualJSON) == nil {
				debug.BodyJSON = actualJSON
			} else {
				debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
			}
		} else {
			debug.Body = &FixtureBody{Encoding: "base64", Value: base64.StdEncoding.EncodeToString(actual.Body)}
		}

		b := marshalIndentOrPlaceholder(debug)
		fmt.Fprintf(os.Stderr, "  got: %s\n", string(b))

		logs := marshalIndentOrPlaceholder(app.logs)
		metrics := marshalIndentOrPlaceholder(app.metrics)
		spans := marshalIndentOrPlaceholder(app.spans)
		fmt.Fprintf(os.Stderr, "  got.logs: %s\n", string(logs))
		fmt.Fprintf(os.Stderr, "  got.metrics: %s\n", string(metrics))
		fmt.Fprintf(os.Stderr, "  got.spans: %s\n", string(spans))
	} else {
		fmt.Fprintf(os.Stderr, "  got: <unavailable>\n")
	}

	if f.Expect.Response != nil {
		expected := *f.Expect.Response
		expected.Headers = canonicalizeHeaders(expected.Headers)
		b := marshalIndentOrPlaceholder(expected)
		fmt.Fprintf(os.Stderr, "  expected: %s\n", string(b))
	} else {
		fmt.Fprintf(os.Stderr, "  expected: <unavailable>\n")
	}

	logs := marshalIndentOrPlaceholder(f.Expect.Logs)
	metrics := marshalIndentOrPlaceholder(f.Expect.Metrics)
	spans := marshalIndentOrPlaceholder(f.Expect.Spans)
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
