package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const baseWorkflow = `
name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches:
      - staging
      - main
      - premain
  workflow_dispatch:
    inputs:
      run_full_rubric:
        type: boolean
        default: true
jobs:
  release-security-gates:
    name: Release/security gates
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  prerelease-readiness:
    name: Prerelease readiness (staging -> premain)
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/verify-release-eligibility.sh
  staging-release-eligibility:
    name: Release eligibility (staging -> premain)
    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || (github.event_name == 'push' && github.ref == 'refs/heads/staging')
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/verify-release-eligibility.sh
  builds:
    name: Verify deterministic builds
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  rubric:
    name: Rubric (full gate set)
    if: (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`

const rubricIfPrefix = "    if: (github.event_name == 'workflow_dispatch'"

func writeWorkflow(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ci.yml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write workflow: %v", err)
	}
	return path
}

func evaluateText(t *testing.T, text string) ([]string, error) {
	t.Helper()
	workflow, err := loadWorkflow(writeWorkflow(t, text))
	if err != nil {
		return nil, err
	}
	return evaluateWorkflow(workflow)
}

func mustPass(t *testing.T, text string) {
	t.Helper()
	failures, err := evaluateText(t, text)
	if err != nil {
		t.Fatalf("guard errored on valid wiring: %v", err)
	}
	if len(failures) > 0 {
		t.Fatalf("guard must PASS on valid wiring, got: %v", failures)
	}
}

func mustFailWith(t *testing.T, text, want string) {
	t.Helper()
	failures, err := evaluateText(t, text)
	if err != nil {
		if strings.Contains(err.Error(), want) {
			return
		}
		t.Fatalf("guard errored with %v, want a failure mentioning %q", err, want)
	}
	joined := strings.Join(failures, "\n")
	if !strings.Contains(joined, want) {
		t.Fatalf("guard must FAIL mentioning %q, got: %v", want, failures)
	}
}

func replaceRubricIf(text, replacement string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, rubricIfPrefix) {
			lines[i] = "    if: " + replacement
			return strings.Join(lines, "\n")
		}
	}
	return text
}

func TestGuardPassesCurrentTree(t *testing.T) {
	mustPass(t, baseWorkflow)
}

func TestGuardRejectsBroadenedRubric(t *testing.T) {
	broadenings := map[string]string{
		"negated event on a continuation clause": "(github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || (github.event_name != 'pull_request')",
		"negated event with unary not":           "(github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || !(github.event_name == 'pull_request')",
		"push ref disjunct":                      "(github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || (github.ref == 'refs/heads/staging')",
		"negated base ref":                       "(github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || !(github.event.pull_request.base.ref == 'staging')",
		"plain push":                             "github.event_name == 'push'",
		"all-base pull request":                  "github.event_name == 'pull_request'",
	}
	for _, replacement := range broadenings {
		mustFailWith(t, replaceRubricIf(baseWorkflow, replacement), "staging-pull-request-only")
	}
}

func TestGuardRejectsFoldedRubricCondition(t *testing.T) {
	folded := strings.Replace(baseWorkflow, rubricIfPrefix,
		"    if: >-\n      (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true'))\n      || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')", 1)
	if folded == baseWorkflow {
		t.Fatal("failed to build the folded fixture")
	}
	if _, err := evaluateText(t, folded); err == nil {
		t.Fatal("a folded if: block must fail closed")
	}
}

func TestGuardRejectsNewPromotionOnlyJob(t *testing.T) {
	for _, condition := range []string{
		"github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'premain'",
		"github.event_name == 'pull_request' && github.event.pull_request.base.ref != 'staging'",
		"github.event_name == 'pull_request' && !(github.event.pull_request.base.ref == 'staging')",
		"github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'staging'",
	} {
		text := baseWorkflow + "\n  sneaky-promotion:\n    name: Sneaky promotion\n    if: " + condition + "\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
		mustFailWith(t, text, "no pull-request-to-staging equivalent")
	}
}

func TestGuardRejectsFoldedNewJobCondition(t *testing.T) {
	text := baseWorkflow + "\n  sneaky-folded:\n    name: Sneaky folded\n    if: >-\n      github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
	if _, err := evaluateText(t, text); err == nil {
		t.Fatal("a folded if: block on a new job must fail closed")
	}
}

func TestGuardRejectsPushOnlyJob(t *testing.T) {
	for _, condition := range []string{
		"github.event_name == 'push'",
		"github.event_name != 'pull_request'",
	} {
		text := baseWorkflow + "\n  sneaky-push:\n    name: Sneaky push\n    if: " + condition + "\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
		mustFailWith(t, text, "push parity")
	}
}

func TestGuardRejectsUnmodeledTriggerFilters(t *testing.T) {
	cases := map[string]string{
		"pull_request branches filter": strings.Replace(baseWorkflow,
			"  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n",
			"  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n    branches: [staging]\n", 1),
		"unknown trigger":       strings.Replace(baseWorkflow, "  workflow_dispatch:\n", "  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n", 1),
		"missing synchronize":   strings.Replace(baseWorkflow, "types: [opened, synchronize, reopened, ready_for_review]", "types: [opened]", 1),
		"push branches missing": strings.Replace(baseWorkflow, "      - premain\n", "", 1),
	}
	for label, text := range cases {
		if text == baseWorkflow {
			t.Fatalf("%s: fixture was not modified", label)
		}
		if _, err := evaluateText(t, text); err == nil {
			t.Fatalf("%s: unmodeled wiring must fail closed", label)
		}
	}
}

func TestGuardRejectsYAMLSmuggling(t *testing.T) {
	cases := map[string]string{
		"duplicate job if": baseWorkflow + "    if: github.event_name == 'push'\n",
		"alias":            strings.Replace(baseWorkflow, "  release-security-gates:\n", "  release-security-gates: &base\n", 1) + "\n  clone:\n    <<: *base\n    runs-on: ubuntu-latest\n",
	}
	for label, text := range cases {
		if _, err := evaluateText(t, text); err == nil {
			t.Fatalf("%s: YAML smuggling must fail closed", label)
		}
	}
}

func TestGuardAgainstRealWorkflow(t *testing.T) {
	workflow, err := loadWorkflow(filepath.Join("..", "..", ".github", "workflows", "ci.yml"))
	if err != nil {
		t.Fatalf("load real workflow: %v", err)
	}
	failures, err := evaluateWorkflow(workflow)
	if err != nil {
		t.Fatalf("evaluate real workflow: %v", err)
	}
	if len(failures) > 0 {
		t.Fatalf("real workflow must PASS, got: %v", failures)
	}
}
