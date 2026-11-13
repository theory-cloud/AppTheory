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
  "proofProfiles": {
    "default": {"environment": {"go": "go1.27.4", "node": "24", "python": "3.14", "platform": {"os": "darwin", "arch": "arm64"}}},
    "floor-node22": {"environment": {"go": "go1.27.4", "node": "22", "python": "3.12", "platform": {"os": "linux", "arch": "x64"}}},
    "floor-py3.12": {"environment": {"go": "go1.27.4", "node": "24", "python": "3.12", "platform": {"os": "linux", "arch": "x64"}}},
    "floor-node22-py3.12": {"environment": {"go": "go1.27.4", "node": "22", "python": "3.12", "platform": {"os": "linux", "arch": "x64"}}},
    "floor-node22-py3.14": {"environment": {"go": "go1.27.4", "node": "22", "python": "3.14", "platform": {"os": "linux", "arch": "x64"}}},
    "floor-node24-py3.12": {"environment": {"go": "go1.27.4", "node": "24", "python": "3.12", "platform": {"os": "linux", "arch": "x64"}}}
  },
  "gates": {
    "rubric": {"kind": "source", "profiles": ["default"], "commands": [{"id": "rubric", "argv": ["make", "rubric"]}]},
    "deterministic-builds": {"kind": "source", "profiles": ["default"], "commands": [{"id": "builds", "argv": ["bash", "scripts/verify-builds.sh"]}]},
    "go": {"kind": "source", "profiles": ["default"], "commands": [{"id": "go", "argv": ["bash", "scripts/verify-go.sh"]}]},
    "ts": {"kind": "source", "profiles": ["default", "floor-node22"], "commands": [{"id": "ts", "argv": ["bash", "scripts/verify-ts-pack.sh"]}]},
    "py": {"kind": "source", "profiles": ["default", "floor-py3.12"], "commands": [{"id": "py", "argv": ["bash", "scripts/verify-python-build.sh"]}]},
    "contract-tests": {"kind": "source", "profiles": ["default", "floor-node22-py3.12", "floor-node22-py3.14", "floor-node24-py3.12"], "commands": [{"id": "contract", "argv": ["bash", "scripts/verify-contract-tests.sh"]}]},
    "cdk-go-drift": {"kind": "source", "profiles": ["default", "floor-node22"], "commands": [{"id": "drift", "argv": ["bash", "scripts/verify-cdk-go-drift.sh"]}]},
    "examples-local": {"kind": "source", "profiles": ["default"], "commands": [{"id": "examples", "argv": ["make", "examples-local"]}]},
    "security-refresh": {"kind": "dependency-scan", "profiles": ["default"], "commands": [{"id": "scan", "argv": ["bash", "scripts/verify-security-refresh.sh"]}]},
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
        run: bash scripts/evidence/verify-or-execute.sh --gate rubric --profile default
  builds:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate deterministic-builds --profile default
  go:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate go --profile default
  ts:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate ts --profile default
  py:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate py --profile default
  contract-tests:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate contract-tests --profile default
  cdk-go-drift:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate cdk-go-drift --profile default
  security-refresh:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate security-refresh --profile default
  release-delta:
    runs-on: ubuntu-latest
    steps:
      - name: Release delta
        env:
          EVIDENCE_FORCE_EXECUTE: "true"
        run: bash scripts/evidence/verify-or-execute.sh --gate release-delta
  runtime-floor-matrix:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - node-version: "22"
            python-version: "3.12"
            ts-profile: floor-node22
            py-profile: floor-py3.12
            contract-profile: floor-node22-py3.12
          - node-version: "22"
            python-version: "3.14"
            ts-profile: floor-node22
            py-profile: default
            contract-profile: floor-node22-py3.14
          - node-version: "24"
            python-version: "3.12"
            ts-profile: default
            py-profile: floor-py3.12
            contract-profile: floor-node24-py3.12
    steps:
      - name: Floor proof
        run: |
          bash scripts/evidence/verify-or-execute.sh --gate ts --profile "${{ matrix.ts-profile }}"
          bash scripts/evidence/verify-or-execute.sh --gate py --profile "${{ matrix.py-profile }}"
          bash scripts/evidence/verify-or-execute.sh --gate contract-tests --profile "${{ matrix.contract-profile }}"
  cdk-floor-matrix:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - node-version: "22"
            drift-profile: floor-node22
    steps:
      - name: CDK floor proof
        run: bash scripts/evidence/verify-or-execute.sh --gate cdk-go-drift --profile "${{ matrix.drift-profile }}"
`

const evidenceExamplesWorkflowFixture = `name: Examples
on:
  pull_request:
    branches: [staging]
jobs:
  examples-local:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/evidence/verify-or-execute.sh --gate examples-local --profile default
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
				return strings.Replace(text, "bash scripts/evidence/verify-or-execute.sh --gate go --profile default", "bash scripts/verify-go.sh", 1)
			},
			want: "--gate go",
		},
		{
			name: "floor job loses its profile",
			mutate: func(text string) string {
				return strings.Replace(text, `bash scripts/evidence/verify-or-execute.sh --gate ts --profile "${{ matrix.ts-profile }}"`, "bash scripts/evidence/verify-or-execute.sh --gate ts", 1)
			},
			want: "must name a tracked proof profile",
		},
		{
			name: "floor job forces execution again",
			mutate: func(text string) string {
				return strings.Replace(text, "      - name: Floor proof\n        run: |", "      - name: Floor proof\n        env:\n          EVIDENCE_FORCE_EXECUTE: \"true\"\n        run: |", 1)
			},
			want: "instead of naming a tracked proof profile",
		},
		{
			name: "matrix cell names an undeclared profile",
			mutate: func(text string) string {
				return strings.Replace(text, "            py-profile: floor-py3.12\n            contract-profile: floor-node22-py3.12", "            py-profile: floor-py9.9\n            contract-profile: floor-node22-py3.12", 1)
			},
			want: "undeclared proof profile",
		},
		{
			name: "matrix cell names a profile the gate does not support",
			mutate: func(text string) string {
				return strings.Replace(text, "            ts-profile: floor-node22\n            py-profile: floor-py3.12\n            contract-profile: floor-node22-py3.12\n          - node-version: \"22\"\n            python-version: \"3.14\"", "            ts-profile: floor-py3.12\n            py-profile: floor-py3.12\n            contract-profile: floor-node22-py3.12\n          - node-version: \"22\"\n            python-version: \"3.14\"", 1)
			},
			want: "it does not support",
		},
		{
			name: "matrix reference without explicit cells",
			mutate: func(text string) string {
				return strings.Replace(text, "    strategy:\n      matrix:\n        include:\n          - node-version: \"22\"\n            drift-profile: floor-node22\n", "", 1)
			},
			want: "declares no explicit matrix.include cells",
		},
		{
			name: "always-executing job reuses evidence",
			mutate: func(text string) string {
				return strings.Replace(text, "run: bash scripts/verify-release-branch-signatures.sh", "run: bash scripts/evidence/verify-or-execute.sh --gate rubric --profile default", 1)
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
			name:   "gate supports an undeclared profile",
			mutate: func(text string) string { return text },
			registry: func(text string) string {
				return strings.Replace(text, `"profiles": ["default", "floor-node22"], "commands": [{"id": "drift"`, `"profiles": ["default", "floor-node22", "floor-node99"], "commands": [{"id": "drift"`, 1)
			},
			want: "supports undeclared proof profile",
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
