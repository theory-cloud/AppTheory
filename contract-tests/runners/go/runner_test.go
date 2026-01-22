package main

import (
	"path/filepath"
	"testing"
)

func TestAllFixturesPass(t *testing.T) {
	fixturesRoot := filepath.Join("..", "..", "fixtures")
	fixtures, err := loadFixtures(fixturesRoot)
	if err != nil {
		t.Fatalf("loadFixtures: %v", err)
	}
	if len(fixtures) == 0 {
		t.Fatal("expected fixtures")
	}

	for _, f := range fixtures {
		t.Run(f.ID, func(t *testing.T) {
			if err := runFixture(f); err != nil {
				t.Fatalf("fixture failed: %v", err)
			}
		})
	}
}

func TestLoadFixtures_NoFixturesFound(t *testing.T) {
	dir := t.TempDir()
	_, err := loadFixtures(dir)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunFixture_LegacyTier(t *testing.T) {
	f := Fixture{
		ID:   "legacy_1",
		Tier: "legacy",
		Name: "legacy",
		Setup: FixtureSetup{
			Routes: []FixtureRoute{
				{Method: "GET", Path: "/", Handler: "static_pong"},
			},
		},
		Input: FixtureInput{
			Context: FixtureContext{RemainingMS: 0},
			Request: &FixtureRequest{
				Method:   "GET",
				Path:     "/",
				Query:    nil,
				Headers:  nil,
				Body:     FixtureBody{Encoding: "utf8", Value: ""},
				IsBase64: false,
			},
		},
		Expect: FixtureExpect{
			Response: &FixtureResponse{
				Status: 200,
				Headers: map[string][]string{
					"content-type": {"text/plain; charset=utf-8"},
				},
				Cookies:  nil,
				Body:     &FixtureBody{Encoding: "utf8", Value: "pong"},
				BodyJSON: nil,
				IsBase64: false,
			},
			Logs:    nil,
			Metrics: nil,
			Spans:   nil,
		},
	}

	if err := runFixture(f); err != nil {
		t.Fatalf("expected legacy fixture to pass, got %v", err)
	}
}
