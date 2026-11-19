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
    branches: [staging, premain, main]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      release_pr_number:
        type: string
jobs:
  release-security-gates:
    name: Release/security gates
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  release-train-promotion:
    name: Release train promotion gate
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  version-alignment:
    name: Version alignment
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  prerelease-readiness:
    name: Prerelease readiness (staging -> premain)
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - name: Verify user-facing conventional commits exist
        run: |
          bash scripts/verify-release-eligibility.sh \
            --range "origin/premain..origin/staging" \
            --context "prerelease readiness"
  staging-release-eligibility:
    name: Release eligibility (staging -> premain)
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - name: Verify the promotion range stays release-eligible
        env:
          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}
          PR_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: |
          bash scripts/verify-release-eligibility.sh \
            --range "origin/premain..HEAD" \
            --context "staging release eligibility" \
            --allow-main-backmerge \
            --head-ref "${PR_HEAD_REF}" \
            --head-repo "${PR_HEAD_REPOSITORY}" \
            --repository "${GITHUB_REPOSITORY}"
  builds:
    name: Verify deterministic builds
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  release-delta:
    name: Release delta validation
    if: (github.event_name == 'pull_request' && (github.event.pull_request.base.ref == 'premain' || github.event.pull_request.base.ref == 'main') && (github.event.pull_request.head.ref == 'release-please--branches--premain' || github.event.pull_request.head.ref == 'release-please--branches--main')) || (github.event_name == 'workflow_dispatch' && inputs.release_pr_number != '')
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  rubric:
    name: Rubric (full gate set)
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'
    runs-on: ubuntu-latest
    steps:
      - name: Verify the recorded full rubric
        run: echo ok
`

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
	failures := checkParity(jobs, true)
	failures = append(failures, checkStagingLaneShape(workflow, jobs)...)
	failures = append(failures, checkPremainMainShape(workflow, jobs)...)
	failures = append(failures, checkNoGatingPush(workflow)...)
	failures = append(failures, checkNoDeadJobs(jobs)...)
	failures = append(failures, checkRequiredReleaseContexts(jobs)...)
	failures = append(failures, checkExactConditions(jobs)...)
	failures = append(failures, checkBackmergeExemption(jobs)...)
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

// replaceJobIf rewrites one job's job-level if: line. Two staged gates carry the
// same condition, so the fixture targets the job header instead of the text.
func replaceJobIf(text, jobID, replacement string) string {
	lines := strings.Split(text, "\n")
	header := "  " + jobID + ":"
	for i, line := range lines {
		if line != header {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			if strings.HasPrefix(lines[j], "    if:") {
				lines[j] = replacement
				return strings.Join(lines, "\n")
			}
			if strings.HasPrefix(lines[j], "  ") && !strings.HasPrefix(lines[j], "    ") {
				break
			}
		}
	}
	return text
}

func TestGuardPassesCurrentTree(t *testing.T) {
	mustPass(t, baseWorkflow)
}

// TestGuardRejectsGatingPushTrigger pins the verified-once rule: staging is
// where the gates are verified, so ci.yml must not declare a push trigger that
// would re-run them after the merge.
func TestGuardRejectsGatingPushTrigger(t *testing.T) {
	pushing := strings.Replace(baseWorkflow,
		"  workflow_dispatch:\n",
		"  push:\n    branches: [staging, premain, main]\n  workflow_dispatch:\n", 1)
	if pushing == baseWorkflow {
		t.Fatal("failed to build the pushing ci.yml fixture")
	}
	mustFailWith(t, pushing, "must not declare an on: push trigger")
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
		mustFailWith(t, replaceJobIf(baseWorkflow, "rubric", "    if: "+replacement), "staging-pull-request-only")
	}
}

func TestGuardRejectsFoldedRubricCondition(t *testing.T) {
	folded := replaceJobIf(baseWorkflow, "rubric",
		"    if: >-\n      github.event_name == 'pull_request'\n      && github.event.pull_request.base.ref == 'staging'")
	if folded == baseWorkflow {
		t.Fatal("failed to build the folded fixture")
	}
	if _, err := evaluateText(t, folded); err == nil {
		t.Fatal("a folded if: block must fail closed")
	}
}

// TestGuardRejectsEligibilityPushLegRestored pins the promotion-only condition:
// widening the release-eligibility gate back onto a push re-creates the
// post-merge re-verification the policy removed.
func TestGuardRejectsEligibilityPushLegRestored(t *testing.T) {
	pushLegRestored := replaceJobIf(baseWorkflow, eligibilityID, "    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging') || (github.event_name == 'push' && github.ref == 'refs/heads/staging')")
	if pushLegRestored == baseWorkflow {
		t.Fatal("failed to build the eligibility fixture")
	}
	mustFailWith(t, pushLegRestored, "promotion-pull-request-only")
}

// TestGuardRejectsEligibilityOnStagingPullRequest keeps the 2026-10-12 decision:
// a verdict on staging's whole post-release range cannot be demanded on a pull
// request into staging.
func TestGuardRejectsEligibilityOnStagingPullRequest(t *testing.T) {
	prLegRestored := replaceJobIf(baseWorkflow, eligibilityID, "    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging') || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')")
	if prLegRestored == baseWorkflow {
		t.Fatal("failed to build the eligibility fixture")
	}
	mustFailWith(t, prLegRestored, "promotion-pull-request-only")
}

// TestGuardRejectsNewStagingExecutingJob pins the staging-lane shape: a job that
// runs on a pull request to staging must verify a recorded gate result or be one
// of the recorded fast checks.
func TestGuardRejectsNewStagingExecutingJob(t *testing.T) {
	text := baseWorkflow + "\n  sneaky-staging:\n    name: Sneaky staging\n    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/verify-go.sh\n"
	mustFailWith(t, text, "neither verifies a recorded gate result")
}

func TestGuardRejectsNewPromotionOnlyJob(t *testing.T) {
	for _, condition := range []string{
		"github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'premain'",
		"github.event_name == 'pull_request' && github.event.pull_request.base.ref != 'staging'",
		"github.event_name == 'pull_request' && !(github.event.pull_request.base.ref == 'staging')",
		"github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'staging'",
	} {
		text := baseWorkflow + "\n  sneaky-promotion:\n    name: Sneaky promotion\n    if: " + condition + "\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
		mustFailWith(t, text, "only recorded release hygiene may run there")
	}
}

func TestGuardRejectsFoldedNewJobCondition(t *testing.T) {
	text := baseWorkflow + "\n  sneaky-folded:\n    name: Sneaky folded\n    if: >-\n      github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
	if _, err := evaluateText(t, text); err == nil {
		t.Fatal("a folded if: block on a new job must fail closed")
	}
}

// TestNeedsEdgeNarrowsEffectiveTriggers is the SAN-AT1073-R1-F2 guard: a job with
// no if: of its own that needs a promotion-only job can only ever run on the
// promotion lane, while an always() condition lifts that edge. Neither shape is
// recordable release hygiene, so both are rejected by the shape rule.
func TestNeedsEdgeNarrowsEffectiveTriggers(t *testing.T) {
	text := baseWorkflow + "\n  dependent:\n    name: Dependent\n    needs: prerelease-readiness\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n  always-dependent:\n    name: Always dependent\n    needs: prerelease-readiness\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	root, rel := writeWorkflow(t, text)
	workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(rel)), rel)
	if err != nil {
		t.Fatalf("load workflow: %v", err)
	}
	jobs, err := classifyWorkflow(root, workflow, workflow.ctx, "", 0)
	if err != nil {
		t.Fatalf("classify workflow: %v", err)
	}
	classes := classIndex(jobs)
	if classes["dependent"].prBases[stagingBranch] || !classes["dependent"].prBases[premainBranch] {
		t.Fatalf("a needs: edge on a promotion-only job must narrow the dependent to the promotion lane, got %+v", classes["dependent"])
	}
	if !classes["always-dependent"].prBases[stagingBranch] {
		t.Fatalf("always() must lift the needs: edge, got %+v", classes["always-dependent"])
	}
	mustFailWith(t, text, "only recorded release hygiene may run there")
}

// A job gated only on a push can never run once ci.yml declares no push trigger,
// so it fails closed as dead wiring instead of sitting beside the real gates.
func TestGuardRejectsDeadPushOnlyJob(t *testing.T) {
	text := baseWorkflow + "\n  sneaky-push:\n    name: Sneaky push\n    if: github.event_name == 'push'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
	mustFailWith(t, text, "can never run on a modeled trigger")
}

func TestGuardRejectsUnmodeledTriggerFilters(t *testing.T) {
	cases := map[string]string{
		"pull_request branches filter that omits staging": strings.Replace(baseWorkflow,
			"    branches: [staging, premain, main]\n",
			"    branches: [premain, main]\n", 1),
		"pull_request branches filter with an empty list": strings.Replace(baseWorkflow,
			"    branches: [staging, premain, main]\n",
			"    branches: []\n", 1),
		"unknown trigger":     strings.Replace(baseWorkflow, "  workflow_dispatch:\n", "  repository_dispatch:\n  workflow_dispatch:\n", 1),
		"schedule trigger":    strings.Replace(baseWorkflow, "  workflow_dispatch:\n", "  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n", 1),
		"missing synchronize": strings.Replace(baseWorkflow, "types: [opened, synchronize, reopened, ready_for_review]", "types: [opened]", 1),
		"push branches that omit a protected branch": strings.Replace(baseWorkflow,
			"  workflow_dispatch:\n", "  push:\n    branches: [staging, premain]\n  workflow_dispatch:\n", 1),
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

// TestGuardAcceptsStagingPullRequestFilter pins the one branch filter the
// operator ruling of 2026-11-06 allows: a pull_request trigger scoped to
// staging. The filter is modeled and narrows the workflow's classified PR bases
// to staging, so a staging-scoped workflow parses, classifies, and passes parity
// while a filter that omits staging fails closed (TestGuardRejectsUnmodeledTriggerFilters).
func TestGuardAcceptsStagingPullRequestFilter(t *testing.T) {
	text := `name: Examples
on:
  pull_request:
    branches: [staging]
  workflow_dispatch: {}
jobs:
  harness:
    name: Harness
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`
	root := t.TempDir()
	rel := ".github/workflows/examples.yml"
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(full, []byte(text), 0o600); err != nil {
		t.Fatalf("write workflow: %v", err)
	}
	workflow, err := loadWorkflow(full, rel)
	if err != nil {
		t.Fatalf("load workflow: %v", err)
	}
	if got := strings.Join(workflow.ctx.prBranches, ","); got != stagingBranch {
		t.Fatalf("prBranches = %q, want %q", got, stagingBranch)
	}
	jobs, err := classifyWorkflow(root, workflow, workflow.ctx, "", 0)
	if err != nil {
		t.Fatalf("classify workflow: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("classified %d jobs, want 1", len(jobs))
	}
	class := jobs[0].class
	if !class.prBases[stagingBranch] {
		t.Fatal("staging-scoped job must run on pull requests to staging")
	}
	if class.prBases[premainBranch] || class.prBases[mainBranch] {
		t.Fatalf("staging-scoped job must not run on promotion pull requests: %v", class.prBases)
	}
	if failures := checkParity(jobs, false); len(failures) > 0 {
		t.Fatalf("staging-scoped workflow must pass parity, got: %v", failures)
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
		"      - name: Verify the recorded full rubric\n        run: echo ok\n",
		"      - name: Verify the recorded full rubric\n        if: github.event_name == 'workflow_dispatch'\n        run: echo ok\n", 1)
	if text == baseWorkflow {
		t.Fatal("failed to build the step-level fixture")
	}
	mustFailWith(t, text, "must run unconditionally")
}

// A status-only step condition such as if: always() does not depend on the
// event, so it stays allowed.
func TestGuardAcceptsStatusOnlyRubricStep(t *testing.T) {
	text := strings.Replace(baseWorkflow,
		"      - name: Verify the recorded full rubric\n",
		"      - name: Verify the recorded full rubric\n        if: always()\n", 1)
	if text == baseWorkflow {
		t.Fatal("failed to build the status-only fixture")
	}
	mustPass(t, text)
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
	failures := strings.Join(checkPremainMainShape(workflow, jobs), "\n")
	if !strings.Contains(failures, "only recorded release hygiene may run there") {
		t.Fatalf("a promotion-only callee job must fail the release-branch shape rule, got: %v", failures)
	}
	if !strings.Contains(failures, "callee.yml:promoted") {
		t.Fatalf("the failure must name the callee job, got: %v", failures)
	}
}

func TestGuardRejectsUnrecordedAllLaneCallee(t *testing.T) {
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
	failures := strings.Join(checkPremainMainShape(workflow, jobs), "\n")
	if !strings.Contains(failures, "only recorded release hygiene may run there") {
		t.Fatalf("an unrecorded all-lane callee job must fail the release-branch shape rule, got: %v", failures)
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

// TestGuardRejectsUnlistedReleaseJobOnPullRequestReview proves a review-triggered
// job is classified like a pull-request job: only recorded release hygiene may
// report on a premain or main review, because the code-owner approval is the one
// eligible event a generated release pull request can produce.
func TestGuardRejectsUnlistedReleaseJobOnPullRequestReview(t *testing.T) {
	text := strings.Replace(baseWorkflow, "  workflow_dispatch:\n",
		"  pull_request_review:\n    types: [submitted]\n  workflow_dispatch:\n", 1)
	text += "\n  sneaky-review:\n    name: Sneaky review\n    if: github.event_name == 'pull_request_review' && github.event.pull_request.base.ref == 'premain'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sneaky\n"
	mustFailWith(t, text, "runs on a pull request into premain or main")
}

// TestGuardRejectsUnmodeledReviewActivity keeps the review trigger narrow: only
// the submitted activity (the approval) is modeled.
func TestGuardRejectsUnmodeledReviewActivity(t *testing.T) {
	text := strings.Replace(baseWorkflow, "  workflow_dispatch:\n",
		"  pull_request_review:\n    types: [dismissed]\n  workflow_dispatch:\n", 1)
	if _, err := evaluateText(t, text); err == nil || !strings.Contains(err.Error(), "only the submitted activity type is modeled") {
		t.Fatalf("an unmodeled review activity must fail closed, got: %v", err)
	}
}

// TestGuardRejectsScheduleTrigger pins the no-clock rule: a gated workflow that
// also runs on a cron would execute work on a cadence no pull request asked for,
// and the release-lane recovery sweep that used to be the one exception is gone.
func TestGuardRejectsScheduleTrigger(t *testing.T) {
	text := strings.Replace(baseWorkflow, "  workflow_dispatch:\n",
		"  schedule:\n    - cron: '*/20 * * * *'\n  workflow_dispatch:\n", 1)
	mustFailWith(t, text, "not modeled by the parity classifier")
}

// TestGuardRejectsScheduledPublisher keeps the exemption set clock-free too: no
// non-gating publisher may run on a schedule.
func TestGuardRejectsScheduledPublisher(t *testing.T) {
	root := t.TempDir()
	rel := ".github/workflows/pages.yml"
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	published := "name: pages\non:\n  push:\n    branches: [staging]\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
	if err := os.WriteFile(path, []byte(published), 0o600); err != nil {
		t.Fatalf("write workflow: %v", err)
	}
	exemption, ok := findPublisherExemption(rel)
	if !ok {
		t.Fatalf("%s must be a recorded publisher exemption", rel)
	}
	if err := checkPublisherWorkflow(path, rel, exemption); err == nil || !strings.Contains(err.Error(), "not modeled for a non-gating publisher exemption") {
		t.Fatalf("a scheduled publisher exemption must fail closed, got: %v", err)
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

// TestGuardRejectsEligibilityBackmergeExemptionRemoval pins the fix for the
// post-release back-merge regression: dropping the opt-in from the staging
// eligibility step hands the gate back to the plain predicate, which fails the
// returned main back-merge, so it must fail closed here.
func TestGuardRejectsEligibilityBackmergeExemptionRemoval(t *testing.T) {
	text := strings.Replace(baseWorkflow, "            --allow-main-backmerge \\\n", "", 1)
	if text == baseWorkflow {
		t.Fatal("failed to build the exemption-removal fixture")
	}
	mustFailWith(t, text, "must opt in to the post-release main back-merge exemption")
}

// TestGuardRejectsBackmergeOptInOutsideTheStagingLane: the promotion lane
// promotes released content, so opting it into the exemption would let a range
// with no release-driving commit pass the gate that exists to catch exactly that.
func TestGuardRejectsBackmergeOptInOnPromotionLane(t *testing.T) {
	text := strings.Replace(baseWorkflow, `            --context "prerelease readiness"`+"\n",
		"            --context \"prerelease readiness\" \\\n            --allow-main-backmerge\n", 1)
	if text == baseWorkflow {
		t.Fatal("failed to build the promotion-lane fixture")
	}
	mustFailWith(t, text, "must not opt in to the post-release main back-merge exemption")
}

// TestGuardRejectsBackmergeHeadBindingsWidened: the exemption is only narrow
// while the step feeds it the pull-request head ref, the pull-request head
// repository, and this repository. Rebinding or dropping any of them fails.
func TestGuardRejectsBackmergeHeadBindingsWidened(t *testing.T) {
	cases := map[string]string{
		"head ref rebound to the running branch": "          PR_HEAD_REF: ${{ github.ref_name }}\n",
		"head repository binding dropped":        "",
	}
	for label, replacement := range cases {
		text := strings.Replace(baseWorkflow,
			"          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}\n", replacement, 1)
		if text == baseWorkflow {
			t.Fatalf("%s: fixture was not modified", label)
		}
		mustFailWith(t, text, "PR_HEAD_REF")
	}

	text := strings.Replace(baseWorkflow,
		"          PR_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}\n", "", 1)
	if text == baseWorkflow {
		t.Fatal("head repository: fixture was not modified")
	}
	mustFailWith(t, text, "PR_HEAD_REPOSITORY")
}
