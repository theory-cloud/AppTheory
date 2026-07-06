---
title: LLM FAQ
---

# LLM FAQ

This page is the reserved AppTheory answer surface for coding agents. It gives short canonical answers that point back
to the contract-first docs instead of encouraging one-off workarounds.

## What is the shortest deployable AppTheory path?

Use [`examples/cdk/hello-world`](../../examples/cdk/hello-world/README.md). It deploys one Lambda function behind one
`AppTheoryHttpApi` for Go, TypeScript, or Python. The README carries the path through `npm ci`, `cdk synth`,
`cdk bootstrap`, `cdk deploy`, `curl`, and `cdk destroy`.

## Can I stop at `cdk synth`?

No. Synth is a required local proof that the deployment graph renders, but the on-ramp is not complete until the user
runs bootstrap, deploy, curl verification, and destroy in an authorized AWS account. Local automation in this repository
must not perform those cloud-mutating steps without explicit authorization.

## How should a new project be generated?

Use `go run ./cmd/apptheory-init --lang=go|ts|py <target-dir>` from a clean AppTheory checkout. The generated project
contains one app, one deterministic test, and one CDK stack. Runtime and CDK dependencies are pinned to GitHub Release
assets or tags.

## Can AppTheory be installed from npm or PyPI?

No. AppTheory distribution is GitHub Releases only. TypeScript and Python consumers download pinned release assets and
verify `SHA256SUMS.txt`; Go consumers pin the Git tag. See [Dependency Automation](../dependency-automation.md) for
Renovate configuration that understands release-pinned installs.

## Can a handler read the raw Lambda event instead of the normalized request?

No. AppTheory's runtime contract assumes the normalized request/response path and the shared error envelope. If a new
provider event shape is needed, add or extend contract fixtures and converge all three runtimes.

## Which deployment surface should examples use?

Use AppTheory CDK constructs such as `AppTheoryFunction` and `AppTheoryHttpApi`. Do not document raw CDK as the blessed
path for AppTheory applications. If a construct cannot express a required deployment behavior, the construct surface
should grow with tests and snapshots.
