#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

channel="${1:-}"
release_created="${2:-}"
tag_name="${3:-}"

case "${channel}" in
  prerelease|stable) ;;
  *)
    echo "release-publish-postcondition: FAIL (usage: $0 prerelease|stable <release_created> <tag_name>)" >&2
    exit 1
    ;;
esac

expected_tag="v$(./scripts/read-version.sh)"

is_rc_tag() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+-rc(\.[0-9]+)?$ ]]
}

is_stable_tag() {
  [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

require_created_tag() {
  local expected_shape="$1"

  if [[ "${release_created}" != "true" ]]; then
    echo "release-publish-postcondition: FAIL (release-please no-op is a failed ${expected_shape} publish gate; release_created=${release_created:-<empty>})" >&2
    exit 1
  fi

  if [[ -z "${tag_name}" ]]; then
    echo "release-publish-postcondition: FAIL (${expected_shape} publish gate created a release without tag_name)" >&2
    exit 1
  fi

  if [[ "${tag_name}" != "${expected_tag}" ]]; then
    echo "release-publish-postcondition: FAIL (${expected_shape} tag ${tag_name} != expected ${expected_tag})" >&2
    exit 1
  fi
}

case "${channel}" in
  prerelease)
    if is_rc_tag "${expected_tag}"; then
      require_created_tag "RC"
      if ! is_rc_tag "${tag_name}"; then
        echo "release-publish-postcondition: FAIL (prerelease tag ${tag_name} is not RC-shaped)" >&2
        exit 1
      fi
      echo "release-publish-postcondition: PASS (RC ${tag_name})"
      exit 0
    fi

    if [[ "${release_created}" == "true" ]]; then
      echo "release-publish-postcondition: FAIL (premain must not publish stable-shaped tag ${tag_name:-<empty>})" >&2
      exit 1
    fi

    echo "release-publish-postcondition: PASS (pending RC PR generation for ${expected_tag})"
    ;;
  stable)
    if is_rc_tag "${expected_tag}"; then
      if [[ "${release_created}" == "true" ]]; then
        echo "release-publish-postcondition: FAIL (main must never create or advertise RC tag ${tag_name:-<empty>})" >&2
        exit 1
      fi
      echo "release-publish-postcondition: PASS (pending stable PR generation from RC handoff ${expected_tag})"
      exit 0
    fi

    require_created_tag "stable"
    if ! is_stable_tag "${tag_name}"; then
      echo "release-publish-postcondition: FAIL (stable tag ${tag_name} is not stable-shaped)" >&2
      exit 1
    fi
    echo "release-publish-postcondition: PASS (stable ${tag_name})"
    ;;
esac
