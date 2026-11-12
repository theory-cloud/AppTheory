package main

import (
	"strings"
	"testing"
)

func TestParseConditionRejectsUnmodeledConstructs(t *testing.T) {
	cases := []string{
		"contains(github.ref)",
		"contains(github.ref, 'staging', 'extra')",
		"startsWith(github.ref 'refs/heads/')",
		"github.ref_name == 'staging'",
		"github.head_ref == 'staging'",
		"github.base_ref == 'staging'",
		"github.event.pull_request.head.repo.full_name == 'theory-cloud/AppTheory'",
		"hashFiles('go.sum') != ''",
		"github.event_name == 'pull_request' &&",
	}
	for _, source := range cases {
		if _, err := parseCondition(source); err == nil {
			t.Fatalf("parseCondition(%q) must fail closed on unmodeled wiring", source)
		}
	}
}

func TestParseConditionModelsKnownForms(t *testing.T) {
	cases := []string{
		"github.event_name == 'pull_request'",
		"github.event_name != 'pull_request' || github.event.pull_request.draft == false",
		"(github.event_name == 'workflow_dispatch' && inputs.run_full_rubric == 'true') || !(github.event.pull_request.base.ref == 'staging')",
		"github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'premain'",
		"contains(github.event.head_commit.message, 'release-please--branches--')",
		"startsWith(github.ref, 'refs/heads/')",
		"endsWith(github.ref, 'staging')",
		"always()",
		"${{ github.event_name == 'pull_request' }}",
	}
	for _, source := range cases {
		if _, err := parseCondition(source); err != nil {
			t.Fatalf("parseCondition(%q) unexpectedly failed: %v", source, err)
		}
	}
}

func TestStringPredicatesFollowContextAvailability(t *testing.T) {
	condition, err := parseCondition("contains(github.event.head_commit.message, 'release-please--branches--')")
	if err != nil {
		t.Fatalf("parseCondition failed: %v", err)
	}
	cases := []struct {
		state state
		want  bool
	}{
		{state{event: "pull_request", head: "release-please--branches--premain"}, false},
		{state{event: "push", headMessage: "Merge pull request #1 from x/release-please--branches--premain"}, true},
		{state{event: "push", headMessage: "Merge pull request #1 from x/ordinary"}, false},
	}
	for _, test := range cases {
		got, err := condition.eval(test.state)
		if err != nil {
			t.Fatalf("eval failed: %v", err)
		}
		if got != test.want {
			t.Fatalf("eval(%+v) = %v, want %v", test.state, got, test.want)
		}
	}
}

func TestNormalizeExpression(t *testing.T) {
	got := normalizeExpression("${{  github.event_name   == 'pull_request' }}")
	if want := "github.event_name == 'pull_request'"; got != want {
		t.Fatalf("normalizeExpression = %q, want %q", got, want)
	}
}

func TestReferencedInputs(t *testing.T) {
	got := referencedInputs("(inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')")
	if len(got) != 1 || got[0] != "run_full_rubric" {
		t.Fatalf("referencedInputs = %v, want [run_full_rubric]", got)
	}
	if strings.Join(referencedInputs("github.ref == 'refs/heads/staging'"), ",") != "" {
		t.Fatal("referencedInputs must be empty when no inputs are read")
	}
}
