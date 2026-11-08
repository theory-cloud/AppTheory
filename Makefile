# AppTheory Makefile

.PHONY: all build test test-unit lint fmt fmt-check rubric contract-tests contract-one verify-builds \
	examples-local examples-local-down examples-local-selftest verify-cdk-synth-location-independent \
	theorycloud-apptheory-subtree verify-theorycloud-apptheory-subtree \
	sync-theorycloud-apptheory-subtree trigger-theorycloud-publish \
	verify-theorycloud-apptheory-publish-config

TOOLCHAIN := $(shell awk '/^toolchain / {print $$2}' go.mod | head -n 1)
export GOTOOLCHAIN ?= $(TOOLCHAIN)

all: fmt lint test build

build:
	@echo "Building release artifacts..."
	@./scripts/verify-ts-dist-drift.sh
	@./scripts/verify-ts-pack.sh
	@./scripts/verify-python-build.sh
	@./scripts/verify-cdk-ts-pack.sh
	@./scripts/verify-cdk-python-build.sh

test: test-unit
	@./scripts/verify-version-alignment.sh

test-unit:
	@go test $$(./scripts/list-go-packages.sh)

lint:
	@./scripts/verify-go-lint.sh
	@./scripts/verify-ts-lint.sh
	@./scripts/verify-python-lint.sh

fmt:
	@files="$$(git ls-files '*.go' | while read -r f; do if [ -f "$$f" ]; then echo "$$f"; fi; done)"; \
	if [ -n "$$files" ]; then \
		gofmt -w $$files; \
	fi

fmt-check:
	@./scripts/fmt-check.sh

rubric:
	@./scripts/verify-rubric.sh

# Local example execution: the checked-in DynamoDB Local profile plus every
# example entrypoint classified by scripts/local/examples-local.json.
# EXAMPLES_LOCAL_ARGS exists only for the harness-owned slot/port flags (CI
# pins the slot to its service container and passes --external so the harness
# waits for it instead of starting a second container). No example reads it and
# no operator environment variable is required.
examples-local:
	@python3 scripts/local/test_examples_local.py
	@python3 scripts/local/run_examples_local.py $(EXAMPLES_LOCAL_ARGS)

examples-local-selftest:
	@python3 scripts/local/test_examples_local.py

examples-local-down:
	@python3 scripts/local/run_examples_local.py --down $(EXAMPLES_LOCAL_ARGS)

# Real MCP clients against the local MCP auth-facade example. LOCAL ONLY: never
# a CI job. Each client runs with an isolated home under $HOME/.cache, carrying
# only its model-provider credential (mode 0600, deleted with the scratch); the
# operator's real homes and MCP OAuth stores are never read or modified.
local-clients:
	@python3 scripts/local/local_clients.py $(LOCAL_CLIENTS_ARGS)

# Re-synthesizes every pinned CDK example from a copy under $HOME and requires
# the same template hashes. The copy is source-only, so this proves the pins do
# not depend on the checkout's absolute path; it costs a second full synth run,
# which is why it runs in CI's examples-local job instead of `make rubric`.
verify-cdk-synth-location-independent:
	@./scripts/verify-cdk-synth-location-independent.sh

contract-tests:
	@./scripts/verify-contract-tests.sh

# GNU make collapses every failed recipe to exit 2; rubric classifiers invoke
# verifier scripts directly, so their FAIL (1) and BLOCKED (2) codes remain distinct.
contract-one:
	@if [ -z "$(ID)" ]; then echo "contract-one: FAIL (set ID=<fixture-id>)" >&2; exit 1; fi
	@./scripts/verify-fixture-schema.sh
	@go run ./contract-tests/runners/go --id "$(ID)"
	@bash -c 'source scripts/lib/ts-runtime-deps.sh && ensure_ts_runtime_deps_installed'
	@node contract-tests/runners/ts/run.cjs --id "$(ID)"
	@python3 contract-tests/runners/py/run.py --id "$(ID)"

verify-builds:
	@./scripts/verify-builds.sh

theorycloud-apptheory-subtree:
	@bash ./scripts/stage-theorycloud-apptheory-subtree.sh

verify-theorycloud-apptheory-subtree:
	@bash ./scripts/verify-theorycloud-apptheory-subtree.sh

sync-theorycloud-apptheory-subtree:
	@bash ./scripts/sync-theorycloud-apptheory-subtree.sh

trigger-theorycloud-publish:
	@bash ./scripts/trigger-theorycloud-publish.sh

verify-theorycloud-apptheory-publish-config:
	@bash ./scripts/verify-theorycloud-apptheory-publish-config.sh
