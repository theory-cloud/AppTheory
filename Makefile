# AppTheory Makefile

.PHONY: all build test test-unit lint fmt fmt-check rubric verify-builds

TOOLCHAIN := $(shell awk '/^toolchain / {print $$2}' go.mod | head -n 1)
export GOTOOLCHAIN ?= $(TOOLCHAIN)

all: fmt lint test build

build:
	@echo "Building release artifacts..."
	@./scripts/verify-ts-pack.sh
	@./scripts/verify-python-build.sh
	@./scripts/verify-cdk-ts-pack.sh
	@./scripts/verify-cdk-python-build.sh

test: test-unit
	@./scripts/verify-version-alignment.sh

test-unit:
	@go test ./...

lint:
	@./scripts/verify-go.sh

fmt:
	@files="$$(git ls-files '*.go' | while read -r f; do if [ -f "$$f" ]; then echo "$$f"; fi; done)"; \
	if [ -n "$$files" ]; then \
		gofmt -w $$files; \
	fi

fmt-check:
	@./scripts/fmt-check.sh

rubric:
	@./scripts/verify-rubric.sh

verify-builds:
	@./scripts/verify-builds.sh
