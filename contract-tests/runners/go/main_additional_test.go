package main

import (
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestRun_ReturnCodesForNoFixturesPassAndFail(t *testing.T) {
	// NOTE: This test mutates global flag/os state; it must not run in parallel.
	fixturesRoot := t.TempDir()

	if code := runWithArgs(t, []string{"-fixtures", fixturesRoot}); code != 2 {
		t.Fatalf("expected exit code 2 for missing fixtures, got %d", code)
	}

	// Passing fixture.
	writeFixture(t, fixturesRoot, "p0", "pass.json", Fixture{
		ID:   "fixture_pass",
		Tier: "p0",
		Name: "pass",
		Setup: FixtureSetup{
			Routes: []FixtureRoute{{Method: "GET", Path: "/ping", Handler: "static_pong"}},
		},
		Input: FixtureInput{
			Request: &FixtureRequest{
				Method:  "GET",
				Path:    "/ping",
				Query:   map[string][]string{},
				Headers: map[string][]string{},
				Body:    FixtureBody{Encoding: "utf8", Value: ""},
			},
		},
		Expect: FixtureExpect{
			Response: &FixtureResponse{
				Status:  200,
				Headers: map[string][]string{"content-type": {"text/plain; charset=utf-8"}},
				Body:    &FixtureBody{Encoding: "utf8", Value: "pong"},
			},
		},
	})

	if code := runWithArgs(t, []string{"-fixtures", fixturesRoot}); code != 0 {
		t.Fatalf("expected exit code 0 for passing fixtures, got %d", code)
	}

	// Add a failing fixture so the suite returns 1.
	writeFixture(t, fixturesRoot, "p0", "fail.json", Fixture{
		ID:   "fixture_fail",
		Tier: "p0",
		Name: "fail",
		Setup: FixtureSetup{
			Routes: []FixtureRoute{{Method: "GET", Path: "/ping", Handler: "static_pong"}},
		},
		Input: FixtureInput{
			Request: &FixtureRequest{
				Method:  "GET",
				Path:    "/ping",
				Query:   map[string][]string{},
				Headers: map[string][]string{},
				Body:    FixtureBody{Encoding: "utf8", Value: ""},
			},
		},
		Expect: FixtureExpect{
			Response: &FixtureResponse{
				Status:  201, // intentional mismatch
				Headers: map[string][]string{"content-type": {"text/plain; charset=utf-8"}},
				Body:    &FixtureBody{Encoding: "utf8", Value: "pong"},
			},
		},
	})

	if code := runWithArgs(t, []string{"-fixtures", fixturesRoot}); code != 1 {
		t.Fatalf("expected exit code 1 when any fixture fails, got %d", code)
	}
}

func runWithArgs(t *testing.T, args []string) int {
	t.Helper()

	oldArgs := os.Args
	oldCommandLine := flag.CommandLine
	t.Cleanup(func() {
		os.Args = oldArgs
		flag.CommandLine = oldCommandLine
	})

	flag.CommandLine = flag.NewFlagSet("contract-tests-go", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = append([]string{"contract-tests-go"}, args...)
	return run()
}

func writeFixture(t *testing.T, root, tier, name string, f Fixture) {
	t.Helper()

	dir := filepath.Join(root, tier)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	raw, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), raw, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}
