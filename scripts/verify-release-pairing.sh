#!/usr/bin/env bash
# Purpose: verify apptheory-init templates pair with the release CDK asset for the
# tag the templates substitute, so generated scaffolds peer-resolve against the
# artifact that is actually published instead of only against the working tree.
#
# Why this exists on top of scripts/verify-scaffold-examples.sh: that gate packs the
# working-tree cdk/ directory, so it can only prove template pins match the tree it
# runs on. It cannot see the release-process skew this gate closes - a tree whose
# VERSION already names a published release with different peers, a template CDK
# asset URL that names a different tag than VERSION substitutes, or a release packed
# at a version other than the one the templates point at.
#
# Modes:
#   (default)          pack cdk/ and pair it with templates rendered by the real
#                      scaffolder for the VERSION tag (the release-candidate arm).
#   --tarball <path>   verify pairing against an already-packed CDK tarball.
#   --published        download the published CDK release asset for the tag and
#                      pair the templates against those immutable bytes.
#   --self-test        prove both directions on synthetic skew, fail closed.
#
# Every failure path exits non-zero; there are no warn-only paths.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repo_root="$PWD"

mode="local"
tarball_override=""
tag_override=""
published=false

usage() {
  cat <<'USAGE'
usage: scripts/verify-release-pairing.sh [--tag <tag>] [--tarball <path>] [--published] [--self-test]
USAGE
}

while (( $# > 0 )); do
  case "$1" in
    --tag)
      tag_override="${2:-}"
      if [[ -z "${tag_override}" ]]; then
        echo "release-pairing: FAIL (--tag requires a value)" >&2
        exit 1
      fi
      shift
      ;;
    --tarball)
      tarball_override="${2:-}"
      if [[ -z "${tarball_override}" ]]; then
        echo "release-pairing: FAIL (--tarball requires a path)" >&2
        exit 1
      fi
      shift
      ;;
    --published) published=true ;;
    --self-test) mode="self-test" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "release-pairing: FAIL (unknown argument '$1')" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ "${published}" == "true" && "${mode}" == "self-test" ]]; then
  echo "release-pairing: FAIL (--published and --self-test are mutually exclusive)" >&2
  exit 1
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "release-pairing: BLOCKED (${cmd} not found)" >&2
    exit 2
  fi
}

github_repo_slug() {
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    printf '%s\n' "${GITHUB_REPOSITORY}"
    return 0
  fi

  local remote_url
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  case "${remote_url}" in
    git@github.com:*) remote_url="${remote_url#git@github.com:}" ;;
    https://github.com/*) remote_url="${remote_url#https://github.com/}" ;;
    http://github.com/*) remote_url="${remote_url#http://github.com/}" ;;
    *) return 1 ;;
  esac
  remote_url="${remote_url%.git}"
  if [[ ! "${remote_url}" =~ ^[^/]+/[^/]+$ ]]; then
    return 1
  fi
  printf '%s\n' "${remote_url}"
}

require_cmd python3
require_cmd tar

version="$(./scripts/read-version.sh)"
tag="v${version}"
if [[ -n "${tag_override}" && "${tag_override}" != "${tag}" ]]; then
  # The scaffold substitutes __APPTHEORY_TAG__ = "v" + VERSION, so a gate that runs
  # where the tag and VERSION disagree would verify a pairing nobody ships.
  echo "release-pairing: FAIL (tag ${tag_override} != v${version} from VERSION; templates substitute the VERSION tag)" >&2
  exit 1
fi

expected_asset="theory-cloud-apptheory-cdk-${version}.tgz"

work_root="$(mktemp -d "${TMPDIR:-/tmp}/release-pairing.XXXXXX")"
cleanup() {
  rm -rf "${work_root}"
}
trap cleanup EXIT

cdk_tarball="${tarball_override}"
tarball_basename=""

if [[ -n "${cdk_tarball}" ]]; then
  if [[ ! -f "${cdk_tarball}" ]]; then
    echo "release-pairing: FAIL (--tarball ${cdk_tarball} does not exist)" >&2
    exit 1
  fi
  tarball_basename="$(basename "${cdk_tarball}")"
elif [[ "${published}" == "true" ]]; then
  require_cmd curl
  if ! repo_slug="$(github_repo_slug)"; then
    echo "release-pairing: FAIL (--published could not resolve the GitHub repository slug)" >&2
    exit 1
  fi
  published_url="https://github.com/${repo_slug}/releases/download/${tag}/${expected_asset}"
  curl_args=(-fsSL)
  token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ -n "${token}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${token}")
  fi
  # Draft release assets are not served from the public release URL, so an HTTP
  # 200 download is itself proof the asset is published and therefore immutable.
  if ! curl "${curl_args[@]}" -o "${work_root}/${expected_asset}" "${published_url}" 2>/dev/null; then
    echo "release-pairing: FAIL (${tag} has no published asset ${expected_asset} at ${published_url})" >&2
    exit 1
  fi
  cdk_tarball="${work_root}/${expected_asset}"
  tarball_basename="${expected_asset}"
else
  require_cmd npm
  if [[ ! -f "cdk/package.json" ]]; then
    echo "release-pairing: FAIL (missing cdk/package.json)" >&2
    exit 1
  fi
  if ! (cd "${repo_root}/cdk" && npm pack --silent --pack-destination "${work_root}" >/dev/null); then
    echo "release-pairing: FAIL (npm pack failed for cdk/)" >&2
    exit 1
  fi
  cdk_tarball="$(find "${work_root}" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [[ -z "${cdk_tarball}" || ! -f "${cdk_tarball}" ]]; then
    echo "release-pairing: FAIL (npm pack produced no cdk tarball)" >&2
    exit 1
  fi
  tarball_basename="$(basename "${cdk_tarball}")"
fi

cdk_pkg_json="${work_root}/cdk-package.json"
if ! tar -xzOf "${cdk_tarball}" package/package.json > "${cdk_pkg_json}"; then
  echo "release-pairing: FAIL (${tarball_basename} has no package/package.json)" >&2
  exit 1
fi

# cmd/apptheory-init is the authoritative substitution for the template placeholders,
# so render the templates with it instead of re-deriving the substitution here.
require_cmd go
rendered_root="${work_root}/rendered"
for lang in go ts py; do
  if ! go run ./cmd/apptheory-init --lang="${lang}" "${rendered_root}/${lang}" >/dev/null; then
    echo "release-pairing: FAIL (could not render ${lang} template with cmd/apptheory-init)" >&2
    exit 1
  fi
done

python3 - "${mode}" "${cdk_pkg_json}" "${rendered_root}" "${tag}" "${version}" "${tarball_basename}" <<'PY'
import copy
import json
import re
import sys
from pathlib import Path

MODE, CDK_PKG_JSON, RENDERED_ROOT, TAG, VERSION, TARBALL_BASENAME = sys.argv[1:7]

CDK_NAME = "@theory-cloud/apptheory-cdk"
APP_NAME = "@theory-cloud/apptheory"
ASSET_BASE = "https://github.com/theory-cloud/AppTheory/releases/download"
LANGS = ("go", "ts", "py")


class PairingError(Exception):
    pass


def fail(message):
    raise PairingError(message)


# --- version/range algebra -------------------------------------------------
#
# Deliberately bounded: this verifies the declarative pins a template ships, not the
# npm registry. Any syntax it cannot decide fails closed rather than passing.
def parse_version(text, ctx):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", text.strip())
    if not match:
        fail(f"{ctx}: unsupported version syntax {text!r}")
    return tuple(int(group) for group in match.groups())


def parse_partial(text, ctx):
    raw = text.strip()
    if raw.startswith("v"):
        raw = raw[1:]
    parts = raw.split(".")
    if not 1 <= len(parts) <= 3:
        fail(f"{ctx}: unsupported version syntax {text!r}")
    values = []
    for part in parts:
        if part in ("x", "X", "*"):
            values.append(None)
            continue
        if not re.fullmatch(r"\d+", part) or None in values:
            fail(f"{ctx}: unsupported version syntax {text!r}")
        values.append(int(part))
    while values and values[-1] is None:
        values.pop()
    if not values:
        fail(f"{ctx}: unsupported version syntax {text!r}")
    return {
        "major": values[0],
        "minor": values[1] if len(values) > 1 else None,
        "patch": values[2] if len(values) > 2 else None,
    }


def floor(partial):
    return (
        partial["major"],
        partial["minor"] if partial["minor"] is not None else 0,
        partial["patch"] if partial["patch"] is not None else 0,
    )


def caret_bounds(partial):
    major, minor, patch = partial["major"], partial["minor"], partial["patch"]
    if major != 0 or minor is None:
        hi = (major + 1, 0, 0)
    elif minor != 0 or patch is None:
        hi = (0, minor + 1, 0)
    else:
        hi = (0, 0, patch + 1)
    return (floor(partial), True, hi, False)


def tilde_bounds(partial):
    major, minor = partial["major"], partial["minor"]
    if minor is None:
        hi = (major + 1, 0, 0)
    else:
        hi = (major, minor + 1, 0)
    return (floor(partial), True, hi, False)


def plain_bounds(partial):
    low = floor(partial)
    major, minor, patch = partial["major"], partial["minor"], partial["patch"]
    if patch is not None:
        return (low, True, low, True)
    if minor is not None:
        return (low, True, (major, minor + 1, 0), False)
    return (low, True, (major + 1, 0, 0), False)


def comparator_bounds(token, ctx):
    for operator in (">=", "<=", ">", "<", "=", "^", "~"):
        if token.startswith(operator):
            body = token[len(operator) :]
            if not body:
                fail(f"{ctx}: unsupported range syntax {token!r}")
            if operator == "^":
                return caret_bounds(parse_partial(body, ctx))
            if operator == "~":
                return tilde_bounds(parse_partial(body, ctx))
            target = floor(parse_partial(body, ctx))
            if operator == ">=":
                return (target, True, None, True)
            if operator == ">":
                return (target, False, None, True)
            if operator == "<=":
                return (None, True, target, True)
            if operator == "<":
                return (None, True, target, False)
            return (target, True, target, True)
    return plain_bounds(parse_partial(token, ctx))


def tighten(lo, lo_incl, hi, hi_incl, other):
    other_lo, other_lo_incl, other_hi, other_hi_incl = other
    if lo is None:
        lo, lo_incl = other_lo, other_lo_incl
    elif other_lo is not None:
        if other_lo > lo:
            lo, lo_incl = other_lo, other_lo_incl
        elif other_lo == lo:
            lo_incl = lo_incl and other_lo_incl

    if hi is None:
        hi, hi_incl = other_hi, other_hi_incl
    elif other_hi is not None:
        if other_hi < hi:
            hi, hi_incl = other_hi, other_hi_incl
        elif other_hi == hi:
            hi_incl = hi_incl and other_hi_incl

    return (lo, lo_incl, hi, hi_incl)


def conjoin(first, second, ctx):
    window = tighten(first[0], first[1], first[2], first[3], second)
    lo, lo_incl, hi, hi_incl = window
    if lo is not None and hi is not None:
        if lo > hi or (lo == hi and not (lo_incl and hi_incl)):
            fail(f"{ctx}: empty version range")
    return window


def parse_range(text, ctx):
    raw = text.strip()
    if raw == "" or raw in ("*", "x", "X"):
        return (None, True, None, True)
    if "||" in raw:
        fail(f"{ctx}: unsupported range syntax {text!r} (union ranges are not verified)")
    if " - " in raw:
        first, second = raw.split(" - ", 1)
        return conjoin(
            (floor(parse_partial(first, ctx)), True, None, True),
            (None, True, floor(parse_partial(second, ctx)), True),
            ctx,
        )
    bounds = None
    for token in raw.split():
        token_bounds = comparator_bounds(token, ctx)
        bounds = token_bounds if bounds is None else conjoin(bounds, token_bounds, ctx)
    if bounds is None:
        fail(f"{ctx}: unsupported range syntax {text!r}")
    return bounds


def intersect(first, second):
    return tighten(first[0], first[1], first[2], first[3], second)


def is_empty(window):
    lo, lo_incl, hi, hi_incl = window
    if lo is None or hi is None:
        return False
    if lo < hi:
        return False
    if lo == hi:
        return not (lo_incl and hi_incl)
    return True


def declarations(package):
    merged = {}
    for field in ("dependencies", "devDependencies", "peerDependencies"):
        merged.update(package.get(field) or {})
    return merged


def disjoint_neighbour(peer_range, ctx):
    """A pin guaranteed not to intersect the peer range, for skew proofs."""
    raw = peer_range.strip()
    if re.fullmatch(r"v?\d+\.\d+\.\d+", raw):
        major, minor, patch = parse_version(raw, ctx)
        if minor > 0:
            return f"{major}.{minor - 1}.{patch}"
        if major > 0:
            return f"{major - 1}.0.{patch}"
        fail(f"{ctx}: cannot build a disjoint neighbour for {peer_range!r}")
    match = re.fullmatch(r"[\^~]v?(\d+)\.(\d+)\.(\d+)", raw)
    if match:
        return f"{int(match.group(1)) + 1}.0.0"
    fail(f"{ctx}: cannot build a disjoint neighbour for {peer_range!r}")


def check_pairing(cdk_package, rendered, tag, version, tarball_basename):
    if cdk_package.get("name") != CDK_NAME:
        fail(f"cdk artifact is {cdk_package.get('name')!r}, expected {CDK_NAME!r}")
    if cdk_package.get("version") != version:
        fail(
            f"cdk artifact version {cdk_package.get('version')!r} != VERSION {version!r} "
            "(release candidate packed at the wrong version)"
        )
    if tarball_basename and tarball_basename != f"theory-cloud-apptheory-cdk-{version}.tgz":
        fail(
            f"cdk tarball {tarball_basename!r} does not match the release asset name "
            f"'theory-cloud-apptheory-cdk-{version}.tgz'"
        )

    peers = cdk_package.get("peerDependencies") or {}
    if not peers:
        fail("cdk artifact declares no peerDependencies; template pairing cannot be verified")

    cdk_asset_url = f"{ASSET_BASE}/{tag}/theory-cloud-apptheory-cdk-{version}.tgz"
    app_asset_url = f"{ASSET_BASE}/{tag}/theory-cloud-apptheory-{version}.tgz"

    for lang in LANGS:
        package = rendered.get(lang)
        if package is None:
            fail(f"{lang}: no rendered package.json")
        declared = declarations(package)

        if declared.get(CDK_NAME) != cdk_asset_url:
            fail(
                f"{lang}: {CDK_NAME} is {declared.get(CDK_NAME)!r}, expected the {tag} release asset "
                f"{cdk_asset_url!r} (version substitution drift)"
            )
        if APP_NAME in declared and declared[APP_NAME] != app_asset_url:
            fail(
                f"{lang}: {APP_NAME} is {declared[APP_NAME]!r}, expected the {tag} release asset "
                f"{app_asset_url!r} (version substitution drift)"
            )

        for name, peer_range in sorted(peers.items()):
            ctx = f"{lang}: {name}"
            if name not in declared:
                fail(
                    f"{ctx}: template does not declare this cdk peer, so {peer_range!r} cannot pair "
                    "(npm install would fail ERESOLVE)"
                )
            peer_window = parse_range(str(peer_range), ctx)
            declared_window = parse_range(str(declared[name]), ctx)
            if is_empty(peer_window) or is_empty(declared_window):
                fail(f"{ctx}: empty version range in template {declared[name]!r} or peer {peer_range!r}")
            if is_empty(intersect(peer_window, declared_window)):
                fail(
                    f"{ctx}: template pin {declared[name]!r} cannot satisfy the release cdk peer "
                    f"{peer_range!r} (npm install would fail ERESOLVE)"
                )

    return peers


def load_rendered(root):
    rendered = {}
    for lang in LANGS:
        path = Path(root) / lang / "package.json"
        if not path.is_file():
            fail(f"missing rendered template package.json at {lang}/package.json")
        rendered[lang] = json.loads(path.read_text(encoding="utf-8"))
    return rendered


def run_self_test():
    cdk_package = json.loads(Path(CDK_PKG_JSON).read_text(encoding="utf-8"))
    rendered = load_rendered(RENDERED_ROOT)

    peers = check_pairing(cdk_package, rendered, TAG, VERSION, TARBALL_BASENAME)
    print(
        f"release-pairing: PASS (self-test baseline: {len(peers)} cdk peer(s) paired across {'/'.join(LANGS)})"
    )

    cases = []

    for name, peer_range in sorted(peers.items()):
        drift = copy.deepcopy(rendered)
        drift["ts"]["devDependencies"][name] = disjoint_neighbour(peer_range, f"self-test {name}")
        cases.append(
            (
                f"template {name} pin moved away from the cdk peer {peer_range}",
                cdk_package,
                drift,
                "cannot satisfy the release cdk peer",
            )
        )

    tag_drift = copy.deepcopy(rendered)
    tag_drift["ts"]["devDependencies"][CDK_NAME] = (
        f"{ASSET_BASE}/v0.0.1/theory-cloud-apptheory-cdk-0.0.1.tgz"
    )
    cases.append(
        (
            "template cdk asset URL names a tag other than VERSION substitutes",
            cdk_package,
            tag_drift,
            "version substitution drift",
        )
    )

    wrong_version = copy.deepcopy(cdk_package)
    wrong_version["version"] = "0.0.0"
    cases.append(
        (
            "release candidate packed at a version other than VERSION",
            wrong_version,
            copy.deepcopy(rendered),
            "release candidate packed at the wrong version",
        )
    )

    undeclared = copy.deepcopy(rendered)
    for name in peers:
        for field in ("dependencies", "devDependencies"):
            undeclared["go"].get(field, {}).pop(name, None)
    cases.append(
        (
            "template omits a cdk peer declaration",
            cdk_package,
            undeclared,
            "template does not declare this cdk peer",
        )
    )

    unsupported = copy.deepcopy(rendered)
    unsupported["py"]["devDependencies"][sorted(peers)[0]] = ">=1.0.0 <2.0.0 || >=3.0.0"
    cases.append(
        (
            "template pin uses range syntax the verifier cannot decide",
            cdk_package,
            unsupported,
            "union ranges are not verified",
        )
    )

    for description, package, rendered_case, expected_fragment in cases:
        try:
            check_pairing(package, rendered_case, TAG, VERSION, TARBALL_BASENAME)
        except PairingError as error:
            if expected_fragment not in str(error):
                fail(f"self-test {description}: rejected with unexpected diagnostic {str(error)!r}")
            print(f"release-pairing: FAIL-PROOF (self-test rejected: {description}) -> {error}")
            continue
        fail(f"self-test {description}: skew was ACCEPTED; the gate is not fail-closed")

    print(f"release-pairing: PASS (self-test: baseline paired, {len(cases)} skew case(s) failed closed)")


def main():
    cdk_package = json.loads(Path(CDK_PKG_JSON).read_text(encoding="utf-8"))
    rendered = load_rendered(RENDERED_ROOT)
    peers = check_pairing(cdk_package, rendered, TAG, VERSION, TARBALL_BASENAME)
    summary = ", ".join(f"{name} {value}" for name, value in sorted(peers.items()))
    print(
        f"release-pairing: PASS (tag {TAG}; {TARBALL_BASENAME} declares {summary}; "
        f"templates {'/'.join(LANGS)} paired)"
    )


try:
    if MODE == "self-test":
        run_self_test()
    else:
        main()
except PairingError as error:
    print(f"release-pairing: FAIL ({error})", file=sys.stderr)
    raise SystemExit(1)
PY
