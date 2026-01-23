package main

import (
	"strings"
	"testing"
)

func TestPrintFailure_NonP0_PrintsGotAndExpected(t *testing.T) {
	out := captureStderr(t, func() {
		printFailure(Fixture{
			ID:   "fixture_1",
			Name: "example",
			Tier: "p1",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "static_pong"},
				},
			},
			Input: FixtureInput{
				Context: FixtureContext{RemainingMS: 50},
				Request: &FixtureRequest{
					Method:  "GET",
					Path:    "/ping",
					Headers: map[string][]string{},
					Query:   map[string][]string{},
					Body:    FixtureBody{Encoding: "utf8", Value: ""},
				},
			},
			Expect: FixtureExpect{
				Response: &FixtureResponse{
					Status:   200,
					Headers:  map[string][]string{"content-type": {"application/json; charset=utf-8"}},
					BodyJSON: []byte(`{"ok":true}`),
				},
			},
		}, errSentinel("boom"))
	})

	if !strings.Contains(out, "FAIL fixture_1") {
		t.Fatalf("expected FAIL line, got:\n%s", out)
	}
	if !strings.Contains(out, "got:") || !strings.Contains(out, "expected:") {
		t.Fatalf("expected got/expected sections, got:\n%s", out)
	}
}

func TestPrintFailure_MissingRequest_PrintsUnavailable(t *testing.T) {
	out := captureStderr(t, func() {
		printFailure(Fixture{
			ID:   "fixture_2",
			Name: "missing request",
			Tier: "p1",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "static_pong"},
				},
			},
			Input:  FixtureInput{Request: nil},
			Expect: FixtureExpect{},
		}, errSentinel("boom"))
	})
	if !strings.Contains(out, "<unavailable>") {
		t.Fatalf("expected unavailable output, got:\n%s", out)
	}
}

func TestPrintFailure_P0_DelegatesToPrintFailureP0(t *testing.T) {
	out := captureStderr(t, func() {
		printFailure(Fixture{
			ID:   "fixture_3",
			Name: "p0",
			Tier: "p0",
			Setup: FixtureSetup{
				Routes: []FixtureRoute{
					{Method: "GET", Path: "/ping", Handler: "unknown_handler"},
				},
			},
			Input: FixtureInput{
				Request: &FixtureRequest{
					Method:  "GET",
					Path:    "/ping",
					Headers: map[string][]string{},
					Query:   map[string][]string{},
					Body:    FixtureBody{Encoding: "utf8", Value: ""},
				},
			},
			Expect: FixtureExpect{
				Response: &FixtureResponse{Status: 200},
			},
		}, errSentinel("boom"))
	})
	if !strings.Contains(out, "FAIL fixture_3") {
		t.Fatalf("expected FAIL line, got:\n%s", out)
	}
	if !strings.Contains(out, "expected:") {
		t.Fatalf("expected expected output, got:\n%s", out)
	}
}

func TestSummarizeFailures_SortsByID(t *testing.T) {
	out := captureStderr(t, func() {
		summarizeFailures([]Fixture{
			{ID: "b"},
			{ID: "a"},
		})
	})

	idxA := strings.Index(out, "- a")
	idxB := strings.Index(out, "- b")
	if idxA == -1 || idxB == -1 || idxA > idxB {
		t.Fatalf("expected sorted output, got:\n%s", out)
	}
}

type errSentinel string

func (e errSentinel) Error() string { return string(e) }
