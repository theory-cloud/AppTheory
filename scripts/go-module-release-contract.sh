#!/usr/bin/env bash
# Shared fail-closed helpers for the AppTheory v2+ Go module release transaction.

go_release_parse_tag() {
  local tag="${1:-}"
  local major

  if [[ ! "${tag}" =~ ^v([0-9]+)\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?$ ]]; then
    echo "go-module-release: FAIL (unsupported v2+ release tag '${tag}')" >&2
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  if (( 10#${major} < 2 )); then
    echo "go-module-release: FAIL (unsupported v2+ release tag '${tag}')" >&2
    return 1
  fi

  GO_RELEASE_TAG="${tag}"
  GO_RELEASE_VERSION="${tag#v}"
  GO_RELEASE_MAJOR="${major}"
  GO_RELEASE_ROOT_MODULE="github.com/theory-cloud/apptheory/v${GO_RELEASE_MAJOR}"
  GO_RELEASE_CDK_MODULE="github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v${GO_RELEASE_MAJOR}"
  GO_RELEASE_ROOT_TAG="${tag}"
  GO_RELEASE_CDK_TAG="cdk-go/apptheorycdk/${tag}"
}

go_release_module_from_commit() {
  local commit="$1"
  local path="$2"

  git show "${commit}:${path}" 2>/dev/null |
    awk '/^module[[:space:]]+/{print $2; exit}'
}

go_release_version_from_commit() {
  local commit="$1"
  local raw

  raw="$(git show "${commit}:VERSION" 2>/dev/null | head -n 1 || true)"
  if [[ ! "${raw}" =~ ^([0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+)?)?)($|[[:space:]]) ]]; then
    echo "go-module-release: FAIL (${commit} has an invalid VERSION marker)" >&2
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

go_release_validate_source_contract() {
  local tag="$1"
  local source_ref="$2"
  local source_commit
  local source_version
  local root_module
  local cdk_module

  go_release_parse_tag "${tag}" || return 1

  source_commit="$(git rev-parse --verify "${source_ref}^{commit}" 2>/dev/null || true)"
  if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "go-module-release: FAIL (source '${source_ref}' is not a local commit)" >&2
    return 1
  fi

  source_version="$(go_release_version_from_commit "${source_commit}")" || return 1
  if [[ "${source_version}" != "${GO_RELEASE_VERSION}" ]]; then
    echo \
      "go-module-release: FAIL (${tag} version ${GO_RELEASE_VERSION} does not match ${source_commit} VERSION ${source_version})" \
      >&2
    return 1
  fi

  root_module="$(go_release_module_from_commit "${source_commit}" "go.mod")"
  if [[ "${root_module}" != "${GO_RELEASE_ROOT_MODULE}" ]]; then
    echo \
      "go-module-release: FAIL (${source_commit} root module '${root_module}' != '${GO_RELEASE_ROOT_MODULE}')" \
      >&2
    return 1
  fi

  cdk_module="$(go_release_module_from_commit "${source_commit}" "cdk-go/apptheorycdk/go.mod")"
  if [[ "${cdk_module}" != "${GO_RELEASE_CDK_MODULE}" ]]; then
    echo \
      "go-module-release: FAIL (${source_commit} CDK module '${cdk_module}' != '${GO_RELEASE_CDK_MODULE}')" \
      >&2
    return 1
  fi

  if git cat-file -e "${source_commit}:cdk-go/go.mod" 2>/dev/null ||
    git cat-file -e "${source_commit}:cdk-go/go.sum" 2>/dev/null
  then
    echo \
      "go-module-release: FAIL (${source_commit} retains legacy cdk-go parent-module files)" \
      >&2
    return 1
  fi

  GO_RELEASE_SOURCE_COMMIT="${source_commit}"
}

# Prints the commit targeted by one remote tag.
# Return codes: 0=present, 1=absent, 2=remote/ref resolution failure.
go_release_remote_tag_commit() {
  local remote="$1"
  local tag="$2"
  local remote_line
  local status
  local safe_tag
  local temporary_ref
  local target

  set +e
  remote_line="$(
    git ls-remote --exit-code --refs "${remote}" "refs/tags/${tag}" 2>/dev/null
  )"
  status=$?
  set -e

  if (( status == 2 )); then
    return 1
  fi
  if (( status != 0 )) || [[ -z "${remote_line}" ]]; then
    echo "go-module-release: FAIL (could not inspect ${remote} refs/tags/${tag})" >&2
    return 2
  fi

  safe_tag="${tag//\//_}"
  temporary_ref="refs/apptheory-release-check/$$-${RANDOM}/${safe_tag}"
  if ! git fetch --quiet --no-tags "${remote}" "refs/tags/${tag}:${temporary_ref}"; then
    echo "go-module-release: FAIL (could not resolve ${remote} refs/tags/${tag})" >&2
    git update-ref -d "${temporary_ref}" >/dev/null 2>&1 || true
    return 2
  fi

  target="$(git rev-parse --verify "${temporary_ref}^{commit}" 2>/dev/null || true)"
  git update-ref -d "${temporary_ref}" >/dev/null 2>&1 || true
  if [[ ! "${target}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "go-module-release: FAIL (${remote} refs/tags/${tag} is not commit-resolvable)" >&2
    return 2
  fi

  printf '%s\n' "${target}"
}
