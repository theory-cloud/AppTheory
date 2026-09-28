package main

import (
	"strings"
	"testing"
)

func TestParseConditionRejectsUnmodeledConstructs(t *testing.T) {
	cases := []string{
		"contains(github.ref, 'staging')",
		"github.ref_name == 'staging'",
		"github.head_ref == 'staging'",
		"github.base_ref == 'staging'",
		"startsWith(github.ref, 'refs/heads/')",
		"github.event.pull_request.head.repo.full_name == 'theory-cloud/AppTheory'",
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
		"always()",
		"${{ github.event_name == 'pull_request' }}",
	}
	for _, source := range cases {
		if _, err := parseCondition(source); err != nil {
			t.Fatalf("parseCondition(%q) unexpectedly failed: %v", source, err)
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
