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
      - if: always()
        uses: actions/upload-artifact@1111111111111111111111111111111111111111
`

const rubricIfPrefix = "    if: (github.event_name == 'workflow_dispatch'"
const eligibilityIfPrefix = "    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')"

func writeWorkflow(t *testing.T, text string) (string, string) {
	t.Helper()
	root := t.TempDir()
	rel := ciWorkflowPath
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(text), 0o600); err != nil {
		t.Fatalf("write workflow: %v", err)
	}
	return root, rel
}

func evaluateText(t *testing.T, text string) ([]string, error) {
	t.Helper()
	root, rel := writeWorkflow(t, text)
	workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(rel)), rel)
	if err != nil {
		return nil, err
	}
	jobs, err := classifyWorkflow(root, workflow, workflow.ctx, "", 0)
	if err != nil {
		return nil, err
	}
	failures := checkParity(jobs)
	failures = append(failures, checkExactConditions(jobs)...)
	failures = append(failures, checkExemptionsAreLive(jobs)...)
	failures = append(failures, checkCanary(jobs)...)
	failures = append(failures, checkUnconditionalSteps(jobs)...)
	return failures, nil
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

func replaceLine(text, prefix, replacement string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, prefix) {
			lines[i] = replacement
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
		mustFailWith(t, replaceLine(baseWorkflow, rubricIfPrefix, "    if: "+replacement), "staging-pull-request-only")
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

// TestGuardRejectsEligibilityPushLegRemoval is the ADV-1073-R1-01 regression:
// dropping the push-to-staging leg of the release-eligibility gate must fail,
// not pass as a semantically weaker condition.
func TestGuardRejectsEligibilityPushLegRemoval(t *testing.T) {
	prOnly := replaceLine(baseWorkflow, eligibilityIfPrefix, "    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'")
	if prOnly == baseWorkflow {
		t.Fatal("failed to build the eligibility fixture")
	}
	mustFailWith(t, prOnly, "pull-request-to-staging-plus-push-to-staging")
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

// TestGuardRejectsNeedsInducedPromotionJob is the SAN-AT1073-R1-F2 bypass: a job
// with no if: of its own that needs a promotion-only job can only ever run on
// the promotion lane, so it must be classified as promotion-only.
func TestGuardRejectsNeedsInducedPromotionJob(t *testing.T) {
	text := baseWorkflow + "\n  sneaky-dependent:\n    name: Sneaky dependent\n    needs: prerelease-readiness\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
	mustFailWith(t, text, "no pull-request-to-staging equivalent")
}

// A needs: edge on a job that does run on the PR-to-staging lane stays parity
// clean, so the needs: handling is not a blanket failure.
func TestGuardAcceptsNeedsOnSharedJob(t *testing.T) {
	text := baseWorkflow + "\n  shared-dependent:\n    name: Shared dependent\n    needs: release-security-gates\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	mustPass(t, text)
}

// always() lifts the needs: gate: the dependent job runs even when the job it
// needs was skipped, so it keeps its own (all-lane) triggers.
func TestGuardAcceptsNeedsWithAlways(t *testing.T) {
	text := baseWorkflow + "\n  always-dependent:\n    name: Always dependent\n    needs: prerelease-readiness\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	mustPass(t, text)
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

// TestGuardRejectsEventDependentRubricStep is the ADV-1073-R1-03(b) bypass: a
// step-level if: that only runs the substantive step on a dispatch vacates the
// gate while the rubric check name still reports green on a staging PR.
func TestGuardRejectsEventDependentRubricStep(t *testing.T) {
	text := strings.Replace(baseWorkflow,
		"      - run: echo ok\n      - if: always()\n",
		"      - if: github.event_name == 'workflow_dispatch'\n        run: echo ok\n", 1)
	if text == baseWorkflow {
		t.Fatal("failed to build the step-level fixture")
	}
	mustFailWith(t, text, "must run unconditionally")
}

// A status-only step condition such as if: always() does not depend on the
// event, so it stays allowed.
func TestGuardAcceptsStatusOnlyRubricStep(t *testing.T) {
	if !strings.Contains(baseWorkflow, "if: always()") {
		t.Fatal("fixture must carry the evidence upload's if: always()")
	}
	mustPass(t, baseWorkflow)
}

func TestGuardRejectsRemoteReusableWorkflowJob(t *testing.T) {
	text := baseWorkflow + "\n  remote:\n    uses: octo/example/.github/workflows/reuse.yml@1111111111111111111111111111111111111111\n"
	mustFailWith(t, text, "not modeled")
}

func TestGuardRejectsUnmodeledCallee(t *testing.T) {
	text := baseWorkflow + "\n  remote:\n    uses: ./.github/workflows/nowhere.yml\n"
	mustFailWith(t, text, "nowhere.yml")
}

func TestGuardRejectsPromotionOnlyCallee(t *testing.T) {
	root, rel := writeWorkflow(t, baseWorkflow+"\n  calls-callee:\n    uses: ./.github/workflows/callee.yml\n")
	calleeRel := ".github/workflows/callee.yml"
	callee := "name: callee\non:\n  workflow_call:\njobs:\n  promoted:\n    name: Promoted only\n    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo promoted\n"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(calleeRel)), []byte(callee), 0o600); err != nil {
		t.Fatalf("write callee: %v", err)
	}
	workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(rel)), rel)
	if err != nil {
		t.Fatalf("load caller: %v", err)
	}
	jobs, err := classifyWorkflow(root, workflow, workflow.ctx, "", 0)
	if err != nil {
		t.Fatalf("classify caller: %v", err)
	}
	failures := strings.Join(checkParity(jobs), "\n")
	if !strings.Contains(failures, "no pull-request-to-staging equivalent") {
		t.Fatalf("a promotion-only callee job must fail parity, got: %v", failures)
	}
	if !strings.Contains(failures, "callee.yml:promoted") {
		t.Fatalf("the failure must name the callee job, got: %v", failures)
	}
}

func TestGuardAcceptsAllLaneCallee(t *testing.T) {
	root, rel := writeWorkflow(t, baseWorkflow+"\n  calls-callee:\n    uses: ./.github/workflows/callee.yml\n")
	calleeRel := ".github/workflows/callee.yml"
	callee := "name: callee\non:\n  workflow_call:\njobs:\n  shared:\n    name: Shared\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo shared\n"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(calleeRel)), []byte(callee), 0o600); err != nil {
		t.Fatalf("write callee: %v", err)
	}
	workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(rel)), rel)
	if err != nil {
		t.Fatalf("load caller: %v", err)
	}
	jobs, err := classifyWorkflow(root, workflow, workflow.ctx, "", 0)
	if err != nil {
		t.Fatalf("classify caller: %v", err)
	}
	if failures := checkParity(jobs); len(failures) > 0 {
		t.Fatalf("an all-lane callee job must pass parity, got: %v", failures)
	}
}

func TestGuardRejectsNeedsCycle(t *testing.T) {
	text := baseWorkflow + "\n  cycle-a:\n    needs: cycle-b\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n  cycle-b:\n    needs: cycle-a\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	if _, err := evaluateText(t, text); err == nil {
		t.Fatal("a needs: cycle must fail closed")
	}
}

func TestGuardRejectsUnknownNeed(t *testing.T) {
	text := baseWorkflow + "\n  dangling:\n    needs: does-not-exist\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	if _, err := evaluateText(t, text); err == nil {
		t.Fatal("an unknown needs: target must fail closed")
	}
}

func TestGuardRejectsPublisherExemptionWithPullRequest(t *testing.T) {
	root := t.TempDir()
	rel := ".github/workflows/pages.yml"
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	text := "name: pages\non:\n  push:\n    branches: [staging]\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write pages: %v", err)
	}
	exemption, ok := findPublisherExemption(rel)
	if !ok {
		t.Fatal("pages.yml must be a recorded publisher exemption")
	}
	err := checkPublisherWorkflow(path, rel, exemption)
	if err == nil || !strings.Contains(err.Error(), "pull_request") {
		t.Fatalf("an exempted publisher with a pull_request trigger must fail closed, got: %v", err)
	}
}

func TestGuardRejectsUnmodeledPublisherTrigger(t *testing.T) {
	root := t.TempDir()
	rel := ".github/workflows/pages.yml"
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	text := "name: pages\non:\n  push:\n    branches: [staging]\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write pages: %v", err)
	}
	exemption, _ := findPublisherExemption(rel)
	err := checkPublisherWorkflow(path, rel, exemption)
	if err == nil || !strings.Contains(err.Error(), "not modeled") {
		t.Fatalf("an unmodeled publisher trigger must fail closed, got: %v", err)
	}
}

func TestGuardAgainstRealWorkflows(t *testing.T) {
	repoRoot := filepath.Join("..", "..")
	result, err := evaluateWorkflowDirectory(repoRoot, defaultWorkflowsDir)
	if err != nil {
		t.Fatalf("evaluate real workflows: %v", err)
	}
	if len(result.failures) > 0 {
		t.Fatalf("real workflows must PASS, got: %v", result.failures)
	}
	if result.scanned == 0 || result.classified == 0 {
		t.Fatalf("expected the real tree to scan and classify workflows, got scanned=%d classified=%d", result.scanned, result.classified)
	}
}
