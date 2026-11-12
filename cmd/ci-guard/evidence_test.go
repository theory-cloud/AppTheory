package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const evidenceRegistryFixture = `{
  "schemaVersion": 1,
  "evidenceDirectory": "gov-infra/evidence/proportionate",
  "localLogDirectory": "gov-infra/evidence/proportionate/local",
  "gates": {
    "rubric": {"kind": "source", "commands": [{"id": "rubric", "argv": ["make", "rubric"]}]},
    "deterministic-builds": {"kind": "source", "commands": [{"id": "builds", "argv": ["bash", "scripts/verify-builds.sh"]}]},
    "go": {"kind": "source", "commands": [{"id": "go", "argv": ["bash", "scripts/verify-go.sh"]}]},
    "ts": {"kind": "source", "commands": [{"id": "ts", "argv": ["bash", "scripts/verify-ts-pack.sh"]}]},
    "py": {"kind": "source", "commands": [{"id": "py", "argv": ["bash", "scripts/verify-python-build.sh"]}]},
    "contract-tests": {"kind": "source", "commands": [{"id": "contract", "argv": ["bash", "scripts/verify-contract-tests.sh"]}]},
    "cdk-go-drift": {"kind": "source", "commands": [{"id": "drift", "argv": ["bash", "scripts/verify-cdk-go-drift.sh"]}]},
    "examples-local": {"kind": "source", "commands": [{"id": "examples", "argv": ["make", "examples-local"]}]},
    "security-refresh": {"kind": "dependency-scan", "commands": [{"id": "scan", "argv": ["bash", "scripts/verify-security-refresh.sh"]}]},
    "release-delta": {"kind": "generated-delta", "commands": [{"id": "delta", "argv": ["bash", "scripts/verify-version-alignment.sh"]}]}
  },
  "executionMatrix": [
    {"id": "pr-staging"}, {"id": "push-staging"}, {"id": "pr-staging-premain"},
    {"id": "push-premain"}, {"id": "release-pr-premain"}, {"id": "release-merge-premain"},
    {"id": "pr-premain-main"}, {"id": "push-main"}, {"id": "release-pr-main"},
    {"id": "release-merge-main"}, {"id": "backmerge-main-staging"}
  ]
}`

const evidenceCIWorkflowFixture = `name: CI
on:
  pull_request: {}
  push:
    branches: [staging, premain, main]
  workflow_dispatch:
    inputs:
      release_pr_number:
        type: string
jobs:
  release-security-gates:
    name: Release/security gates
    runs-on: ubuntu-latest
    steps:
      - name: Verify release/security invariants
        run: bash scripts/verify-release-branch-signatures.sh
  rubric:
    name: Rubric (full gate set)
    runs-on: ubuntu-latest
    steps:
      - name: Run rubric
        run: bash scripts/evidence/verify-or-execute.sh --gate rubric
  builds:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate deterministic-builds
  go:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate go
  ts:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate ts
  py:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate py
  contract-tests:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate contract-tests
  cdk-go-drift:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate cdk-go-drift
  security-refresh:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate security-refresh
  release-delta:
    runs-on: ubuntu-latest
    steps:
      - name: Release delta
        env:
          EVIDENCE_FORCE_EXECUTE: "true"
        run: bash scripts/evidence/verify-or-execute.sh --gate release-delta
  runtime-floor-matrix:
    runs-on: ubuntu-latest
    steps:
      - name: Floor proof
        env:
          EVIDENCE_FORCE_EXECUTE: "true"
        run: |
          bash scripts/evidence/verify-or-execute.sh --gate ts
          bash scripts/evidence/verify-or-execute.sh --gate py
          bash scripts/evidence/verify-or-execute.sh --gate contract-tests
  cdk-floor-matrix:
    runs-on: ubuntu-latest
    steps:
      - name: CDK floor proof
        env:
          EVIDENCE_FORCE_EXECUTE: "true"
        run: bash scripts/evidence/verify-or-execute.sh --gate cdk-go-drift
`

const evidenceExamplesWorkflowFixture = `name: Examples
on:
  pull_request:
    branches: [staging]
jobs:
  examples-local:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate examples-local
`

func writeEvidenceRoot(t *testing.T, ciWorkflow string) string {
	t.Helper()
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, ".github/workflows/ci.yml"), ciWorkflow)
	mustWrite(t, filepath.Join(root, ".github/workflows/examples-local.yml"), evidenceExamplesWorkflowFixture)
	mustWrite(t, filepath.Join(root, "scripts/evidence/validation-gates.json"), evidenceRegistryFixture)
	return root
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestEvidenceWiringPassesOnCompleteWiring(t *testing.T) {
	root := writeEvidenceRoot(t, evidenceCIWorkflowFixture)
	if failures := checkEvidenceWiring(root); len(failures) != 0 {
		t.Fatalf("expected no failures, got %v", failures)
	}
}

func TestEvidenceWiringFailsClosed(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(string) string
		registry func(string) string
		want     string
	}{
		{
			name: "missing gate entry point",
			mutate: func(text string) string {
				return strings.Replace(text, "bash scripts/evidence/verify-or-execute.sh --gate go", "bash scripts/verify-go.sh", 1)
			},
			want: "--gate go",
		},
		{
			name: "floor job stops forcing execution",
			mutate: func(text string) string {
				return strings.Replace(text, "          EVIDENCE_FORCE_EXECUTE: \"true\"\n        run: |\n          bash scripts/evidence/verify-or-execute.sh --gate ts", "        run: |\n          bash scripts/evidence/verify-or-execute.sh --gate ts", 1)
			},
			want: "EVIDENCE_FORCE_EXECUTE",
		},
		{
			name: "always-executing job reuses evidence",
			mutate: func(text string) string {
				return strings.Replace(text, "run: bash scripts/verify-release-branch-signatures.sh", "run: bash scripts/evidence/verify-or-execute.sh --gate rubric", 1)
			},
			want: "must always execute",
		},
		{
			name:   "registry loses a gate",
			mutate: func(text string) string { return text },
			registry: func(text string) string {
				return strings.Replace(text, `"release-delta": {"kind": "generated-delta", "commands": [{"id": "delta", "argv": ["bash", "scripts/verify-version-alignment.sh"]}]}`, `"unused": {"kind": "source", "commands": [{"id": "unused", "argv": ["true"]}]}`, 1)
			},
			want: "missing \"release-delta\"",
		},
		{
			name:   "release delta repeats the source suite",
			mutate: func(text string) string { return text },
			registry: func(text string) string {
				return strings.Replace(text, `"argv": ["bash", "scripts/verify-version-alignment.sh"]`, `"argv": ["make", "rubric"]`, 1)
			},
			want: "must not repeat the source suite",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root := writeEvidenceRoot(t, test.mutate(evidenceCIWorkflowFixture))
			if test.registry != nil {
				mustWrite(t, filepath.Join(root, "scripts/evidence/validation-gates.json"), test.registry(evidenceRegistryFixture))
			}
			failures := checkEvidenceWiring(root)
			if len(failures) == 0 {
				t.Fatalf("expected a failure containing %q", test.want)
			}
			joined := strings.Join(failures, "\n")
			if !strings.Contains(joined, test.want) {
				t.Fatalf("failures %v do not contain %q", failures, test.want)
			}
		})
	}
}
