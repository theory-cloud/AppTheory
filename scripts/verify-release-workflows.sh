#!/usr/bin/env bash
# Purpose: verify GitHub release workflows preserve the immutable release contract.
# --self-test runs the pairing-invocation attack battery without the rest of the pins.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode="verify"
case "${1:-}" in
  "") ;;
  --self-test) mode="self-test" ;;
  *)
    echo "usage: scripts/verify-release-workflows.sh [--self-test]" >&2
    exit 2
    ;;
esac

RELEASE_WORKFLOWS_MODE="${mode}" python3 - <<'PY'
import hashlib
import os
import posixpath
import re
import subprocess
import tempfile
from pathlib import Path

MODE = os.environ.get("RELEASE_WORKFLOWS_MODE", "verify")


def require_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle not in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {needle!r} in {path})")


def require_not_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; unexpected {needle!r} in {path})")


def require_order(path: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} in {path})"
        )


def require_order_after(path: str, anchor: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    anchor_index = text.find(anchor)
    if anchor_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing anchor {anchor!r} in {path})")
    first_index = text.find(first, anchor_index)
    second_index = text.find(second, first_index if first_index != -1 else anchor_index)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} after {anchor!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} after {first!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} after {anchor!r} in {path})"
        )


def require_step_contains(path: str, step_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    marker = f"      - name: {step_name}\n"
    start_index = text.find(marker)
    if start_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing step {step_name!r} in {path})")
    next_step_index = text.find("\n      - ", start_index + len(marker))
    block = text[start_index : next_step_index if next_step_index != -1 else len(text)]
    if needle not in block:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in step {step_name!r} of {path})"
        )


def require_job_contains(path: str, job_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}[ \t]*:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+[ \t]*:\n|\Z)",
        text,
    )
    if match is None or needle not in match.group("block"):
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in job {job_name!r} of {path})"
        )


# ---------------------------------------------------------------------------
# The guarded surface.
#
# The release path is pinned by whole-file SHA-256: the five workflows that run the release
# train, and the transitive closure of the scripts they name. There is no model of YAML or
# of bash anywhere in this file and no admission rule; the pins header below says what that
# replaced and why.
#
# The posture this buys: an intentional change to a pinned file is a visible two-place edit
# - the file and its digest in the manifest - in the same commit. What is *not* pinned
# anywhere in this repository is stated in docs/release-process.md, together with the reason
# it is not.
# ---------------------------------------------------------------------------

ROOT = Path(".").resolve()

GUARDED_BASENAMES = ("verify-release-pairing.sh", "verify-release-workflows.sh")

GUARDED_WORKFLOWS = (
    ".github/workflows/ci.yml",
    ".github/workflows/prerelease-pr.yml",
    ".github/workflows/release-pr.yml",
    ".github/workflows/prerelease.yml",
    ".github/workflows/release.yml",
)

# This guard. A file cannot pin its own bytes, so it is read by nothing here; that boundary
# is stated in docs/release-process.md and asserted by an accepted battery case rather than
# left as prose.
GUARD_PATH = "scripts/verify-release-workflows.sh"

# A script path can be written with a leading `./` or behind a variable that holds a
# directory. This construction is not a shell: it resolves those two spellings, and treats
# any other path as one that names no file.
SCRIPT_REFERENCE = re.compile(r"[A-Za-z0-9_@./${}-]+\.(?:sh|mjs|py|rb)")
VARIABLE_DIRECTORY = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}/")

# Where workflow-invoked scripts live. A script path under one of these roots is part of the
# pinned surface; a path outside them is read as data - a test body, an example handler, a
# library module - and is not part of the release path this guard pins. Pinning those would
# make every library and example edit a pin edit, which is over-blocking with no bound behind
# it; the boundary is stated here instead of implied.
CLOSURE_ROOTS = ("scripts/", "gov-infra/")

# The files outside the pinned set that could gain a call site. `Makefile` exists here and a
# root `package.json` does not; `.github/**` is walked rather than enumerated, so a new
# workflow file or a new composite action is read too.
SWEEP_EXTRA_FILES = ("Makefile", "package.json")


def sweep_paths():
    """Every file the occurrence sweep reads for a guarded script name."""
    paths = []
    github = Path(".github")
    if github.is_dir():
        paths.extend(str(path) for path in sorted(github.rglob("*")) if path.is_file())
    paths.extend(extra for extra in SWEEP_EXTRA_FILES if Path(extra).is_file())
    return tuple(paths)


def script_references(text):
    """Every script-shaped path a file names, exactly as written."""
    return sorted({match.group(0) for match in SCRIPT_REFERENCE.finditer(text)})


def resolve_reference(token, base_dir):
    """The repository-relative path a written token names, or None if it names no file."""
    token = VARIABLE_DIRECTORY.sub("", token)
    if token.startswith("./"):
        token = token[2:]
    candidates = [Path(token)]
    if not token.startswith("/"):
        candidates.append(Path(base_dir) / token)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_file() and resolved.is_relative_to(ROOT):
            return resolved.relative_to(ROOT).as_posix()
    return None


# ---------------------------------------------------------------------------
# Pins.
#
# There is no model of YAML or of bash here, and no admission rule. Every file the release
# path consists of is pinned by its whole-file SHA-256, byte for byte: the five workflows
# that run the release train, and the transitive closure of the scripts they name. Bytes
# either match the pin or they do not.
#
# Rounds 1-5 reasoned about root keys, key identity, job spans and step spans, and each
# round produced a spelling the reasoning did not hold: a root-level key below `jobs:`, a
# quoted duplicate of a job key, a deleted job whose append absorbed the rewrite. The
# reasoning was the hole, so it is deleted rather than repaired, and with it the tolerances
# it needed - whitespace and line endings are bytes as well.
#
# The posture this buys: an intentional change to a pinned file is a visible two-place edit
# - the file and its digest in this manifest - in the same commit. What is *not* pinned
# anywhere in this repository is stated in docs/release-process.md with the reason it is not.
# ---------------------------------------------------------------------------

# The five workflows the release train runs, whole-file. The required release context, the
# release and prerelease publishers, the release PR sync, and every step, job, root key and
# line ending of each of them is one digest here, so there is no region a key could be
# written below and no spelling a key could take that this construction has to know.
WORKFLOW_FILE_DIGESTS = {
    ".github/workflows/ci.yml": "31428c2eb91329ff41c95bdc6d775efc3897089ed1de7e8dcaacafd361210e45",
    ".github/workflows/prerelease-pr.yml": "d5b56f61a63798f84bb7bc1d1fea6100508249ff8865967688d2c6a5c430285c",
    ".github/workflows/release-pr.yml": "20e9dcc2afd278d7d50328eb7eefb6f596477efd0b8e72c0ef16b326611f644d",
    ".github/workflows/prerelease.yml": "0661bc8ae58bc0a8a24c275d33282617cdf7c6981e518fcec779d5b28acdd4a1",
    ".github/workflows/release.yml": "3e2a906dddd9b905bbc840fd6173f1e8166216d4b1b6414bfb82bc27d5ebd629",
}

# The transitive closure of the script paths the five workflows name, resolved relative to
# the repository root or to the referencing file's directory, bounded to CLOSURE_ROOTS.
# `closure_findings` re-derives that closure from the pinned bytes on every run, so a
# workflow that gains a call site, or a pinned script that starts running another one, fails
# until the same change adds the pin - the closure cannot rot into a stale list.
RELEASE_PATH_FILE_DIGESTS = {
    "gov-infra/verifiers/gov-verify-rubric.sh": "5c375a12d5008f671f954c983b03732095b48abd4b5f42f67937e82786f1ea3f",
    "gov-infra/verifiers/test-gov-rubric-timestamp.sh": "9efa7f7486e9049ac8a28c4416ab5a77ee2d660c30596cb025895aba4c7d574a",
    "scripts/check-cdk-engines-floor.mjs": "24d4a6d9e437b55b3fb321b63d9ff7e42e0e3bee2ba5309a8e0a7651a638110e",
    "scripts/check-visible-aws-cdk-finding.mjs": "90539460e8f70fceb1982e5e01ff3b9219acef64867c50cbdd6eb8303f110658",
    "scripts/check-visible-ts-brace-finding.mjs": "6bf7a1e14c993ce06eb75a91fbcda13492215dd8a24837aa349c4cade89527a6",
    "scripts/diagnose-release-state.sh": "53642c06ba3f9c7a561633b5c6065c1ec3008e5bf090843a23d6165b5725d60a",
    "scripts/fmt-check.sh": "de47ba4d3d1b7bfc9a8e78e9fe3ea9d958e01bc63695845624103631f6ca8f3a",
    "scripts/generate-api-snapshots.sh": "f91de9fb0853028c1ccb3ed8d660b80f365c3d17eeb8a2f4f89d3a8de85bfaee",
    "scripts/generate-checksums.sh": "cd5a6f78e5c0efebbf15d09f7b9bfe749d2ee8e85494d4b019194f311d68059e",
    "scripts/go-module-release-contract.sh": "89f98dad00324779da032b53089f562189dabc9a040bed009cdd5ba9f6cfcfe4",
    "scripts/invoke-release-please-pr.mjs": "212693f9a4debdc24d342bf7038ddfe24d5903a1e9d561cd9dbcb564bc06fe03",
    "scripts/invoke-release-please-pr.sh": "f51707ea23aac342c10b51d73b5d239f188dadaf1fd2fab5635a417c7d7b3582",
    "scripts/lib/blocked.sh": "0ea5984eec6b856df5ba2144376c152dd767e5a39e3c451216783844644bd1fa",
    "scripts/lib/cdk-runtime-deps.sh": "4f6787295928f5586545a7203910a37e6b9ab7b76a23ffdca7ea9f12700b9749",
    "scripts/lib/runtime-deps.sh": "9b2fc575343a7fe2389c89c0a6f8adef7e90c18685ac309ecff4505aa151b78c",
    "scripts/lib/ts-runtime-deps.sh": "71c79b7914a4e3c62fe666fe9860ce2ddcf7761307f8f74481a9154fc302b34c",
    "scripts/list-go-packages.sh": "bb7a1234c199cdccf72c20840b92d9376ad025311b79ef19bd25e3b29fa60ee2",
    "scripts/microvm_conformance.py": "c167ece1626939b44cfa41909478b8a06b5f4c7e46239f47c084add3c07587f0",
    "scripts/publish-go-module-tags.sh": "94149628cc8aea55ddd03c72fd14bb903f668ab0632086093c2bad25ea33da3b",
    "scripts/publish-release-assets.sh": "9bc3cbb3d61e1f284bbb770960c4b9c85b1bbd52804cc3d02fa7eaf23b10fe37",
    "scripts/read-version.sh": "eaa550d8d29da26c240934bdb83a1d821fd8693070e6c6a65b1ff001a310fe8c",
    "scripts/render-release-artifact-sync-plan.py": "9fd2a876baa8dbe3da7b0004896d03c17abc7962894fbd8a440869ee74f4cd33",
    "scripts/render-release-notes.sh": "3dd1c51c3fdee91017b6646f63bdce3fdb9a1aa4d795fdbf015d607fa41f1c08",
    "scripts/run-release-please-pr.sh": "e06950248bd9f0877b9992ad2551fe4442c1185d8c9f5b4e48a86c719355f8cd",
    "scripts/stage-release-please-package.sh": "8b94504cf21375b416807a7d09d67ae7f83d4a93dc52da2f165ba4961b1cb325",
    "scripts/stage-theorycloud-apptheory-subtree.sh": "af3d4a0fcee5a42f9d462b58149492e5d151e1784fea33885b16e1d5a1730603",
    "scripts/sync-release-pr-generated.sh": "8414dcdac85face1ddf9ed970b704e7d9430eac90f49c3feb8d1865854aa6c26",
    "scripts/sync-theorycloud-apptheory-subtree.sh": "e6fc9965630486883c77a5d2fa3c831726808dae75b624b8b134e01d18c50627",
    "scripts/test_microvm_conformance.py": "172ec946ddda3cfc6d9329a2721c8fe9dd719f0f2f610f5ab5e88a31ec40229d",
    "scripts/theorycloud-apptheory-env.sh": "9dea6fa6dbacaa8de7084071e3d27724c184dc12362201e658665728d0f51d91",
    "scripts/tools/api_snapshots/py_snapshot.py": "24e7fc8c03bc9955a0408220d1c475b3c941c12e0cc6a83d4827f016fa26e054",
    "scripts/tools/api_snapshots/ts_snapshot.py": "d988493161d67063aeaa702ef2c734fa0509cac70c7cb45dd511c36ef4ccacd3",
    "scripts/trigger-theorycloud-publish.sh": "953014e53db4750fd6003a866ad98734efb285ef347baa424c41695da5e2f703",
    "scripts/update-api-snapshots.sh": "6b4ac01537b94c181fadc395468001bac7f32edf678070c79ef1614f90245744",
    "scripts/update-cdk-generated.sh": "46ab89c5da216b66818b819e71172147941e7278834597283448ff5856d2721c",
    "scripts/update-cdk-readme-inventory.sh": "6166076f01d42c88778f6261d4d8beecdc88e84a4c14dac9a579d139cbf94082",
    "scripts/verify-api-docs.sh": "5021b716482317682b2f3be7e89da842b85b411d13dcf410c2e97e8601e90739",
    "scripts/verify-api-snapshots.sh": "565c444398c424bb50ebaac9aabffab07089c28bf013521ce1d502d3db7a6aed",
    "scripts/verify-branch-release-supply-chain.sh": "805c8f8af1e3a0e600859db1788d5a3ea12a19760e440528b2114e542e4bacda",
    "scripts/verify-branch-version-sync.sh": "38f749592b4b3f3f065313aa8aa33237adc45b3bc327ca5f88ebabda3f272e06",
    "scripts/verify-builds.sh": "001cdf0d9b36390d1334d081e6b9a1b310fec532dd25a2f04180fa2e7c6e21c4",
    "scripts/verify-cdk-audit.sh": "a6800ac4b499bdc778af7a0809fdba10e6a3f539110b4ab24e6a1d561c21c262",
    "scripts/verify-cdk-constructs.sh": "11e7dbc900042be4a84c0d1a8749b107271179f7bf3808fb836c565679b7c3cc",
    "scripts/verify-cdk-deprecation-warnings.sh": "afd09340ee88af80876b9167f603dcbf4940bf049c871ce478ef1c87f1bbec70",
    "scripts/verify-cdk-engines-floor.sh": "f137c37721b66bbd8f20a7a7f40d85da9f36f68f1aee7dedeb17b48a208cfc83",
    "scripts/verify-cdk-go-drift.sh": "9daf96e7746d18828f6dc3f67039fed6deb4d5922641c3f53880cca43fb0cf9c",
    "scripts/verify-cdk-go-major-version.sh": "74d63baea7dd8fdb0b2a4f80fbfc3516e15024cd13a61d39d4510637ec03008f",
    "scripts/verify-cdk-go.sh": "a3f6309d00b3c1638d875678b4c8a9ce7ef49f367d9196d8b21d5a239b19954d",
    "scripts/verify-cdk-python-build.sh": "48a907c88d77930556de8f04c5c1e1918ad798bafa7cf45d4d81dd49ccfad065",
    "scripts/verify-cdk-readme-inventory.sh": "9be0cc469831e22d922bd62c73659266409ec5204a9458b04176475461bd7cf4",
    "scripts/verify-cdk-synth.sh": "2cd8b6952a1a381f1a15e94ce6eccbc03d0708281f6a61748f69d988115f3c25",
    "scripts/verify-cdk-ts-pack.sh": "efbbb077e4b369f846506ecad95f2e21637794f8b4fb59b559fb57e9cc497f2d",
    "scripts/verify-ci-rubric-enforced.sh": "9a08d035c2c65cf10021cada1db7288cf8a18972a9881a073898e80eb392ae67",
    "scripts/verify-contract-tests.sh": "38799a0ee5dc8f6042ca772389847eea584f3a4cd990a0b962e761e22901f8ab",
    "scripts/verify-docs-standard.sh": "a7c0c72fd0d361dc3376d47488b9caede3e41c117b2148489b16d26cd600275b",
    "scripts/verify-fixture-count.sh": "9db4a7bd8cc3d01ddec49ba52004e8a839a9a67246e6e67c92d0ac93d0754569",
    "scripts/verify-fixture-schema.sh": "53aca268596cc3f7e94bed6027b22fd6810a01f53afb878a5877a35f2c28ea82",
    "scripts/verify-go-lint.sh": "799d09ef71e71a27234dd1896cf66fb2d5afe2342aed78309df141c140e3e644",
    "scripts/verify-go-module-tags.sh": "0ca622faf6844a8ee16d0965d5e08be5d9290ed02dafb0e4602cab38c941f80f",
    "scripts/verify-go.sh": "b062274123b7c12b9779eb1799c2582bfb786017ac1fe520dd8f24286282eac9",
    "scripts/verify-microvm-conformance-harness.sh": "e2adb69d12bab33ac127fb44ecaaa64e14998cee6f2d39c805a40d39c3edbf28",
    "scripts/verify-python-build.sh": "7f3b393224672047554016d544cdd8715c723136485dc0dd203649fb0e205ed2",
    "scripts/verify-python-lint.sh": "4d1397f272c70a48a3630204d3dcf7855444f41e9ee51b74ecfa2c0daeaeaf17",
    "scripts/verify-python-tests.sh": "a2c260c78f0c3f9955b1e12e8c0d4cfa23530bfe0b52318863659ff80eaf48b5",
    "scripts/verify-release-branch-signatures.sh": "b252234f19702bb1e1e9893d6047d802b81dbd7d073de64a3ebd24eb86b08c3f",
    "scripts/verify-release-branch.sh": "5707f8ab5af9a0585119cb6691827b2961056897a92537e27763ac2d5c20fd6f",
    "scripts/verify-release-cycle.sh": "63d5d122f4fd2d1f1fb6436d90513a6222543b30461220162bd14c4a26c07662",
    "scripts/verify-release-gates.sh": "ed9bfef8eee60a76437c1e51f9f405644cf6302088431aeb232a96a8450afe18",
    "scripts/verify-release-pairing.sh": "1de72ff31c814730b7c0282fe18693479f0a0ecb39c927e074e3b041d920e902",
    # No pinned workflow names this one. The guard's own verify pass runs it - it is the
    # release-credential boundary test - so it is a root of the closure from here. The guard
    # is unpinned, so this pins the verifier's bytes, not the call of it.
    "scripts/verify-release-please-token-safety.sh": "24961e9733fe1242dae7943b43c70084c9d8a2bee7da05a0a57217b9d322364b",
    "scripts/verify-release-pr-postcondition.sh": "25e41253ec2cd549ae6e85712bc2815ecf91e0d8676e1218f7a42961dbf31416",
    "scripts/verify-release-publish-postcondition.sh": "61b21485d0d97cc06b7c3d62a762fbd79632af78b12cf5e98b8adad6b2ff8766",
    "scripts/verify-release-state.sh": "a55337b19361b3604ad4552faff6077b37a217c51a7a7bf274cdc8e088636753",
    "scripts/verify-release-train-promotion.sh": "7df69fe23210d89d14f8e70bd8118fe9bd7be3e85364385cfd46796d5bca3ba5",
    "scripts/verify-rubric.sh": "c4182067f51cd9bc721b08fed9d4fe0e3ce30d6a020aa0de36e4c8b54f8cc818",
    "scripts/verify-runtime-floor-claims.sh": "d8e452ab43c7eaeb52a91e9003064b5dd5843ea49e0f6e31575ab992bc83152d",
    "scripts/verify-scaffold-examples.sh": "1e242ba49c7cb89112836a946e2964a540f1bbc7ff37fd0ab48651249cd42524",
    "scripts/verify-testkit-examples.sh": "e00d89f230f744762f0b20ef33776d45b396a2df77c0dce3d364e7946b84b973",
    "scripts/verify-theorycloud-apptheory-publish-config.sh": "0e8e1ba2266954338abc90227b08643941be55a0f0d786c71b27515ffa19b11c",
    "scripts/verify-theorycloud-apptheory-subtree.sh": "f6bad2b5ae33be44000590ad682f35ffb463d2cf8865d61547b371d3b3f9d909",
    "scripts/verify-theorycloud-publish-workflow.sh": "afadfd324ec3a81207e2b2aadfc2d88954e279d18dbc3c48b510aea9acff2033",
    "scripts/verify-ts-dist-drift.sh": "177bcfd3ce85ef75d53aef672a431723883f193162f09e8f36c82753dab5e98b",
    "scripts/verify-ts-lint.sh": "2416c9a76cf0ff8db4e06f48b8cff3e433f79a7dc6e175c2756a5fa75748253b",
    "scripts/verify-ts-pack.sh": "1b323b96cff29d81002b01e55263738f41c98da98791a9cae1d409f77b2d35b5",
    "scripts/verify-ts-tests.sh": "dd0bdca95643df4645f71805d0ed5b3231315efe989ed6d9394fec65690b7181",
    "scripts/verify-version-alignment.sh": "ee6513e9f81957eaeefe208c256405ed2c74acf6bcf53cceef35a477264638f9",
}

PINNED_FILE_DIGESTS = dict(WORKFLOW_FILE_DIGESTS, **RELEASE_PATH_FILE_DIGESTS)

# Finding classes. Each attack case in the battery names the class it must fail on, and each
# accepted case names a shape that must produce no finding at all, so a case that starts
# failing - or passing - for an unrelated reason fails the battery loudly.
#
# `digest` is the whole of the pinning construction: a byte of a pinned file changed. There
# is no finer class because there is no finer rule.
CLASS_DIGEST = "digest"
CLASS_CLOSURE = "closure"
CLASS_SWEEP = "sweep"


def read_source(path: str) -> str:
    """Read a pinned file without newline translation.

    `Path.read_text()` opens in universal-newlines mode, so it would hand back `\\r\\n` as `\\n`
    and a CRLF copy of a pinned file would hash equal to its pin. A pinned file is compared
    byte for byte, so its bytes are what is read. The reader probe below fails loudly if this
    function ever stops being byte-faithful.
    """
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


# The probe that keeps the claim above honest. It is the one place the guard tests its own
# reader: a universal-newline reader is a whitespace tolerance by another name, it was
# written into this construction once, and string-mutating battery cases cannot see it.
_reader_probe_body = "line\r\nline\rline\n\ufeffmark"
_reader_probe = Path(tempfile.mkdtemp(prefix="release-workflows-reader-")) / "probe.txt"
_reader_probe.write_text(_reader_probe_body, encoding="utf-8", newline="")
if read_source(str(_reader_probe)) != _reader_probe_body:
    raise SystemExit(
        "release-workflows: FAIL (the pin reader is not byte-faithful: it returned different text "
        "than the file holds, so a CRLF or CR line ending would hash equal to an LF pin)"
    )
_reader_probe.unlink()


def digest_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def tolerance_hint(text: str) -> str:
    """What a mismatch looks like when it is a normalisation a pin does not tolerate."""
    hints = []
    if text.startswith("\ufeff"):
        hints.append("begins with a byte-order mark")
    if "\r" in text:
        hints.append("contains carriage returns (CRLF line endings)")
    if not text.endswith("\n"):
        hints.append("does not end with a newline")
    if not hints:
        return ""
    return (
        "; the file " + " and ".join(hints) + ". Pinned files are compared byte for byte, so the "
        "fix is to normalise the file - the normalisation is visible in the diff - because a "
        "tolerance here is a tolerance an attacker can write through"
    )


def digest_findings(read_text):
    """Every pinned file that is not its pinned revision, byte for byte."""
    findings = []
    for path, pinned in PINNED_FILE_DIGESTS.items():
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError) as error:
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: cannot be read as UTF-8 text ({error}); the release path pins this file by "
                    f"its whole-file SHA-256",
                )
            )
            continue
        actual = digest_of(text)
        if actual != pinned:
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: is not the pinned revision. This file is part of the release path and is "
                    f"pinned by its whole-file SHA-256, so it changes only together with the pin that "
                    f"describes it: replace {pinned} with {actual}{tolerance_hint(text)}",
                )
            )
    return findings


def closure_findings(read_text):
    """Script paths a pinned file names that are themselves pinned by nothing.

    A pinned workflow may name only scripts that are pinned, and a pinned script may run only
    scripts under CLOSURE_ROOTS that are pinned. Anything else is a call site the pins do not
    reach, and it is refused here rather than left to an editor's memory of the manifest.
    """
    findings = []
    for path in PINNED_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        for token in script_references(text):
            resolved = resolve_reference(token, posixpath.dirname(path))
            if resolved is None or resolved == GUARD_PATH or resolved in PINNED_FILE_DIGESTS:
                continue
            if path not in WORKFLOW_FILE_DIGESTS and not resolved.startswith(CLOSURE_ROOTS):
                continue
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{path}: names {token!r}, which resolves to {resolved!r} and is pinned by nothing. A "
                    f"pinned file may run only scripts that are pinned themselves, so the reference and the "
                    f"pin are one change",
                )
            )
    return findings


def pinned_invocation_lines(read_text):
    """The stripped lines of the pinned workflows that name a guarded script.

    A file no pin covers may repeat one of these lines and only these. The line is the pinned
    workflow's own text, so repeating it adds a run of the gate or the guard and cannot weaken
    the step that already runs it.
    """
    lines = set()
    for path in WORKFLOW_FILE_DIGESTS:
        for line in read_text(path).split("\n"):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if any(name in stripped for name in GUARDED_BASENAMES):
                lines.add(stripped)
    return lines


def sweep_findings(read_text, paths=None):
    """Every naming of a guarded script in a file no pin covers.

    A name is admitted from exactly one place: on a line byte-identical to a line a pinned
    workflow holds. That is additive strengthening - running the gate or the guard from
    somewhere else cannot make the step that already runs it stop running - and it is the whole
    of what a file outside the pinned set may say about a guarded script. Every other naming is a
    finding, including one in a new workflow, in a composite action, in the `Makefile` or in
    a root `package.json`.
    """
    findings = []
    admitted = pinned_invocation_lines(read_text)
    for path in (sweep_paths() if paths is None else paths):
        if path in PINNED_FILE_DIGESTS:
            continue
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        for index, line in enumerate(text.split("\n")):
            if not any(name in line for name in GUARDED_BASENAMES):
                continue
            if line.strip() in admitted:
                continue
            findings.append(
                (
                    CLASS_SWEEP,
                    f"{path}:{index + 1}: names a guarded script and is not a byte-identical duplicate of a "
                    f"line a pinned workflow holds ({line.strip()!r}); a file no pin covers may only repeat a "
                    f"pinned invocation line, because repeating it can add a run of the gate and cannot "
                    f"weaken one",
                )
            )
    return findings


def guarded_surface_findings(read_text, sweep=None):
    findings = digest_findings(read_text)
    findings += closure_findings(read_text)
    findings += sweep_findings(read_text, paths=sweep)
    return findings


CI_STEP_HEADER = '      - name: Verify apptheory-init template/release pairing\n'
CI_BARE = '          bash scripts/verify-release-pairing.sh\n'
CI_SELF_TEST = '          bash scripts/verify-release-pairing.sh --self-test\n'
CI_STEP_RUN = '      - name: Verify apptheory-init template/release pairing\n        run: |\n'
CI_STEP = '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n'
CI_JOB = '  release-security-gates:\n    name: Release/security gates\n'
CI_HEAD = 'name: CI\n\non:\n'
CI_GUARD_BARE = '          bash scripts/verify-release-workflows.sh\n'
PREMAIN_GUARD_RUN = '        run: bash scripts/verify-release-workflows.sh\n'
GATES_BARE = 'bash ./scripts/verify-release-pairing.sh\n'
CI_TAIL = '      - name: Run full rubric\n        run: make rubric\n'
RELEASE_TAIL = '          gh workflow run pages.yml --repo "${GITHUB_REPOSITORY}" --ref "${TAG_NAME}" -f tag="${TAG_NAME}"\n'

# Every weakening shape rounds 1-4 closed, verbatim, labels included: a label is the historical
# name of the shape - several of them name a classifier tolerance that no longer exists - and not
# a statement about the pins. Under whole-file pins every one of them fails on the digest of the
# file it edits, and the `Makefile` cases fail on the sweep, so each case names the class it must
# fail on; a case that starts failing, or passing, for an unrelated reason fails the battery too.
ROUND_4_ATTACKS = (
    ('`!` prefix negation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          ! bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('`|| echo advisory`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || echo advisory\n',
     CLASS_DIGEST,
    ),
    ('`if false; then ... fi` wrap', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          if false; then\n            bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_DIGEST,
    ),
    ('commented-out invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          # bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: false\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: ${{ false }}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: ${{ false }}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: always()`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: always()\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if: false\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('`|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('`|| :`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || :\n',
     CLASS_DIGEST,
    ),
    ('`||:`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ||:\n',
     CLASS_DIGEST,
    ),
    ('`&& true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh && true\n',
     CLASS_DIGEST,
    ),
    ('`|| exit 0`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 0\n',
     CLASS_DIGEST,
    ),
    ('`; true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh; true\n',
     CLASS_DIGEST,
    ),
    ('usage-exit flag `--help`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh --help\n',
     CLASS_DIGEST,
    ),
    ('usage-exit flag `-h`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh -h\n',
     CLASS_DIGEST,
    ),
    ('step-level continue-on-error', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        continue-on-error: true\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level continue-on-error', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    continue-on-error: true\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('backslash continuation hiding `|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh \\\n            || true\n',
     CLASS_DIGEST,
    ),
    ('`--self-test`-only step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell: bash {0}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        shell: bash {0}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults: run: shell: bash {0}`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    shell: bash {0}\n\non:\n',
     CLASS_DIGEST,
    ),
    ('env indirection via `BASH_ENV`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASH_ENV: ./weaken.sh\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('flow-style `env: {BASH_ENV: ...}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {BASH_ENV: ./weaken.sh}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `env: BASH_ENV`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      BASH_ENV: ./weaken.sh\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('backgrounded invocation (`&`)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh &\n',
     CLASS_DIGEST,
    ),
    ('duplicate `run:` key in the step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run: bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('duplicate `if:` key on the release PR step', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     "        if: steps.release_pr.outputs.exists == 'true'\n        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     CLASS_DIGEST,
    ),
    ('folded `run: >-` hiding `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: >-\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('heredoc-smuggled invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cat <<EOF\n          bash scripts/verify-release-pairing.sh\n          EOF\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: backgrounded invocation (`&`)', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" &\n',
     CLASS_DIGEST,
    ),
    ('quoted script path', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash "./scripts/verify-release-pairing.sh"\n',
     CLASS_DIGEST,
    ),
    ('variable indirection', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIR="scripts/verify-release-pairing.sh"\n          bash "${PAIR}"\n',
     CLASS_DIGEST,
    ),
    ('release PR step-level `if: false`', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     '        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: commented-out invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     '# scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `if false; then ... fi` wrap', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'if false; then\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\nfi\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit disabled with `set +e`', 'scripts/verify-release-branch.sh',
     '# The apptheory-init templates substitute',
     'set +e\n# The apptheory-init templates substitute',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit never set', 'scripts/verify-release-branch.sh',
     'set -euo pipefail\n',
     'set -uo pipefail\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `bash` shadowed by a function', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash ./scripts/verify-release-pairing.sh\nbash() { return 0; }\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: false` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if: false\n',
     CLASS_DIGEST,
    ),
    ('step-level `continue-on-error: true` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error: true\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell: bash {0}` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell: bash {0}\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: BASH_ENV` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        env:\n          BASH_ENV: ./weaken.sh\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step `if: false` written after the run body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh\n        if: false\n',
     CLASS_DIGEST,
    ),
    ('step body shadows `bash` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body shadows `exit` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          exit() { :; }\n          bash scripts/verify-release-pairing.sh || exit 1\n',
     CLASS_DIGEST,
    ),
    ('step body reassigns PATH', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('PATH prefix on the invocation line', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body clears errexit with `set +e` and a trailing success', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          set +e\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('step body installs a trap that overrides the exit status', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          trap 'exit 0' ERR\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('step body reassigns BASH_ENV', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          export BASH_ENV=./weaken.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step body shadows `bash`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: function shadows `bash` before the invocation', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash() { return 0; }\nbash ./scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `exit() { :; }` with a tolerated fail-closed tail', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'exit() { :; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}" || exit 1\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH prefix on the invocation line', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH reassignment before the invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('`${{ }}` expression as an argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ${{ env.WEAKEN }}\n',
     CLASS_DIGEST,
    ),
    ('variable-indirected `--help` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--help\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('variable-indirected `--self-test` argument in a release PR workflow', '.github/workflows/release-pr.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--self-test\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: variable-indirected argument', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('tolerated tail backgrounded with `&`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 &\n',
     CLASS_DIGEST,
    ),
    ('statement after the tolerated tail', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1; true\n',
     CLASS_DIGEST,
    ),
    ('tolerated tail piped into a command', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 | tee log\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: tolerated tail backgrounded with `&`', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" || return 1 &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in CI', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call backgrounded in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard self-test arm negated in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh --self-test\n',
     '! bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in the prerelease preflight', '.github/workflows/prerelease.yml',
     '        run: bash scripts/verify-release-workflows.sh\n',
     '        run: bash scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step conditional changed in the stable preflight', '.github/workflows/release.yml',
     "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''\n        run: bash scripts/verify-release-workflows.sh\n",
     '        if: false\n        run: bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('YAML merge key in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n<<: *defaults\n\non:\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step invoking the meta-guard with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned extra gate\n        run: |\n          bash scripts/verify-release-workflows.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step invoking the pairing gate with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned pairing gate\n        run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step carrying a conditional', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned conditional gate\n        if: always()\n        run: |\n          bash scripts/verify-release-workflows.sh\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('step-level `if : false` (pre-colon whitespace) after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if : false\n',
     CLASS_DIGEST,
    ),
    ('job-level `if : false` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if : false\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('step-level `continue-on-error : true` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error : true\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell : bash {0}` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell : bash {0}\n',
     CLASS_DIGEST,
    ),
    ('step-level duplicate `run :` key (pre-colon whitespace)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run : bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('step-level `env :` with `PATH:` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env :\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level non-canonical key the guard does not enumerate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        timeout-minutes : 5\n',
     CLASS_DIGEST,
    ),
    ('step-level quoted key `"if": false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        "if": false\n',
     CLASS_DIGEST,
    ),
    ("step-level quoted key `'if' : false`", '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     "      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        'if' : false\n",
     CLASS_DIGEST,
    ),
    ('step-level explicit key `? if`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        ? if\n        : false\n',
     CLASS_DIGEST,
    ),
    ('ANSI-C quoting hiding a `PATH` reassignment', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          PATH=/tmp/evil:$PATH\n          echo 'a' 'b'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('ANSI-C quoting hiding a weakened invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          bash scripts/verify-release-pairing.sh || true\n          echo it is ok\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('invocation inside a function called from an `if` condition', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a function that is never called', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a negated function call', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          ! gate\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a function in a guarded shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'gate() {\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called with `|| true`', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called inside a command substitution', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'x="$(verify_release_pairing_postcondition "${tag_name:-${expected_tag}}")"\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called plainly inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}"\n}\nif A; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host with `|| return 1` inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || return 1\n}\nA\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch with a trailing `|| true`', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch removed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     '',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function stops re-enabling errexit', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function softens its errexit setup', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    set -e\n    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: PATH`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `env: PATH`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      PATH: /tmp/evil\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `env: CDPATH`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nenv:\n  CDPATH: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: BASHOPTS`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASHOPTS: expand_aliases\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: PATH` written as a flow mapping', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {PATH: /tmp/evil}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: `bash` shadowed in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash() { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: stray `PATH` reassignment in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  export PATH="/tmp/evil:${PATH}"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: extra trap in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  trap \'exit 0\' EXIT\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: errexit cleared in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  set +e\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the pinned toolchain export renamed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"\n',
     'export PATH="${GOV_TOOLS_BIN}:${PATH}"\n',
     CLASS_DIGEST,
    ),
    ('flow-style step mapping invoking the pairing gate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - {name: Extra gate, run: "bash scripts/verify-release-pairing.sh || true"}\n',
     CLASS_DIGEST,
    ),
    ('flow-style step mapping invoking the meta-guard', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - {name: Extra guard, run: "bash scripts/verify-release-workflows.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('second YAML document in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n\non:\n---\njobs: {}\n',
     CLASS_DIGEST,
    ),
    ('YAML alias as a step run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - name: Extra anchored gate\n        run: &weak "bash scripts/verify-release-pairing.sh || true"\n      - name: Extra aliased gate\n        run: *weak\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function gate {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a subshell function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() (\n          bash scripts/verify-release-pairing.sh\n          )\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a conditional function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() if true; then\n          bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a brace-poisoned parens-less function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() { echo }\n          function evil {\n          bash scripts/verify-release-pairing.sh\n          }\n          if evil; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function gate {\n  bash ./scripts/verify-release-workflows.sh\n  }\n  if gate; then\n    :\n  fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function gate {\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function bash { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function bash { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function bash { return 0; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('backquote substitution hiding `set +e`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          x="`echo "it\'s"`"\n          set +e\n          echo "it\'s fine"\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('backquote substitution hiding a `PATH` reassignment in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  x="`echo "it\'s"`"\n  export PATH="/tmp/evil:${PATH}"\n  echo "it\'s fine"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level quoted key `"env":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"env":\n  PATH: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('workflow-level quoted key `"defaults":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"defaults":\n  run:\n    shell: bash -c \'exit 0\' {0}\n\non:\n',
     CLASS_DIGEST,
    ),
    ('step keys written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   {name: Fake gate, run: "bash scripts/verify-release-pairing.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unnamed step written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ("gov verifier: the pinned toolchain export's input redirected", 'gov-infra/verifiers/gov-verify-rubric.sh',
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_TOOLS_BIN="/tmp/evil:${GOV_TOOLS_BIN}"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_DIGEST,
    ),
    ('unpinned step key added to a pinned step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_DIGEST,
    ),
    ('second line naming the meta-guard in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n  bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ("step body sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          source /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ("step body dot-sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          . /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ("step body evaluates text into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          eval "$(cat /tmp/evil.sh)"\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body moves the shell before the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cd /tmp/evil\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the checked function sources a file', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  source /tmp/evil.sh\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the checked function moves the shell', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  cd /tmp/evil\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    working-directory: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('job-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    defaults:\n      run:\n        working-directory: /tmp/evil\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('step-level `working-directory`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults.run.shell` in a meta-guard workflow', '.github/workflows/release.yml',
     'name: Release (main)\n',
     "name: Release (main)\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n",
     CLASS_DIGEST,
    ),
    ('exported shell function shadow via `BASH_FUNC_`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          export BASH_FUNC_bash%%='() { return 0; }'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('`hash -p` re-pins the command name', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          hash -p /tmp/evil/bash bash\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('duplicate job name carrying `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    name: Release/security gates\n  release-security-gates:\n    name: Decoy\n    if: false\n',
     CLASS_DIGEST,
    ),
    ('second workflow-level `defaults:` with a poisoned shell', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     "name: CI\ndefaults:\n  run:\n    shell: bash\n\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n\non:\n",
     CLASS_DIGEST,
    ),
)

# Constants the battery anchors on.

# The discarded accepted table, re-evaluated under the collapse. Each of these was admitted
# by round 4's freedom to add a statement or an inert section; each either changes the bytes
# of a pinned file or names a guarded script outside the pins. All six fail closed now. The
# workflow for any of them is to update the pin in the same PR - a documented two-place edit.
ROUND_4_ACCEPTED_RECYCLED = (
    ('trailing comment after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh # pinned in the release doc\n',
     CLASS_DIGEST,
    ),
    ('next-line `true` after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('quoted pinned `--self-test` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh --self-test\n',
     '          bash scripts/verify-release-pairing.sh "--self-test"\n',
     CLASS_DIGEST,
    ),
    ('set +e / set -e capture pair in an unrelated gov verifier function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'check_file_budgets() {\n',
     'check_file_budgets() {\n  set +e\n  :\n  set -e\n',
     CLASS_DIGEST,
    ),
    ('YAML anchor defined in an inert `x-` section', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nx-bodies:\n  weak: &weak "bash scripts/verify-release-pairing.sh || true"\n\non:\n',
     CLASS_DIGEST,
    ),
    ('unrelated verifier added to a pinned release/security step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-api-snapshots.sh\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
)


# ---------------------------------------------------------------------------
# Round 5: the collapse. Every case below is a repro of a finding from the
# adversarial review of round 4 (head 0c85ad5d), re-run against byte-exact pins,
# plus the pin-policy cases the new construction is claimed to have.
# ---------------------------------------------------------------------------

META_GUARD_BODY_FIRST = "          bash scripts/verify-branch-release-supply-chain.sh\n"

ROUND_5_ATTACKS = (
    # F1 - round 4 admitted an own-line extra statement it judged inert. `exit 0`
    # as the first line of a run body is inert in no sense: the pinned statements
    # below it stay byte-identical and never run.
    ("F1 own-line `exit 0` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exit 0\n", CLASS_DIGEST),
    ("F1 own-line `exec true` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exec true\n", CLASS_DIGEST),
    ("F1 own-line `exit 0` first in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST, "          exit 0\n" + META_GUARD_BODY_FIRST, CLASS_DIGEST),
    ("F1 own-line `exit 0` first in the prerelease preflight", ".github/workflows/prerelease.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exit 0\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_DIGEST),
    ("F1 own-line `exec true` first in the stable preflight", ".github/workflows/release.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exec true\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_DIGEST),
    # F2 - the heredoc mask ran on comment-split code without the quoting walker,
    # so a quoted `<<` opened a mask that hid the lines below it.
    ("F2 quoted `<<` opens a mask over a shadowed `bash` and a redirected PATH", ".github/workflows/ci.yml",
     CI_BARE,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          PATH=/tmp/evil:$PATH\n"
     "          true\n" + CI_BARE,
     CLASS_DIGEST),
    ("F2 quoted `<<` opens a mask in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          true\n" + META_GUARD_BODY_FIRST,
     CLASS_DIGEST),
    # F3 - the pinned toolchain closure was incomplete: GOV_INFRA was read by a pinned
    # statement and never pinned itself, and REPO_ROOT and SCRIPT_DIR were pinned by nothing,
    # so one appended assignment re-pointed the toolchain while the pinned statements stayed
    # byte-identical. The whole file is one digest now, so the three cases below are ordinary
    # byte changes - the mechanism they attacked no longer exists.
    ("F3 `GOV_INFRA` redirected above the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_INFRA="/tmp/evilgov"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_DIGEST),
    ("F3 `REPO_ROOT` re-pointed at the head of the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'PLANNING_DIR="${GOV_INFRA}/planning"\n',
     'REPO_ROOT="/tmp/evilrepo"\nPLANNING_DIR="${GOV_INFRA}/planning"\n',
     CLASS_DIGEST),
    ("F3 `SCRIPT_DIR` re-pointed at the head of the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n',
     'SCRIPT_DIR="/tmp/evil"\n',
     CLASS_DIGEST),
    # F4 - pins keyed by (workflow, step name) only, so the pinned step could be
    # moved verbatim into a job that never runs.
    ("F4 pinned ci.yml pairing step moved verbatim into an `if: false` job", ".github/workflows/ci.yml",
     CI_STEP,
     "  quarantined-pairing:\n"
     "    name: Quarantined pairing\n"
     "    if: false\n"
     "    runs-on: ubuntu-latest\n"
     "    steps:\n" + CI_STEP,
     CLASS_DIGEST),
    ("F4 `if: false` added to the pinned ci.yml pairing job", ".github/workflows/ci.yml",
     CI_JOB,
     "  release-security-gates:\n    if: false\n    name: Release/security gates\n",
     CLASS_DIGEST),
    # F5 - the same admitted-freedom rule as F1: an extra statement that names no
    # guarded basename was admitted as inert, and a glob truncate leaves the
    # pinned invocations byte-identical while they run an empty file.
    ("F5 glob truncate of the paired gate before the pinned invocations", ".github/workflows/ci.yml",
     CI_BARE,
     "          printf '' > scripts/verify-release-pa*\n" + CI_BARE,
     CLASS_DIGEST),
    # Round 5's own pin policy.
    ("a new step in a guarded workflow on an unpinned invocation line", ".github/workflows/ci.yml",
     CI_STEP_HEADER,
     "      - name: Extra pairing arm\n        run: |\n"
     "          bash scripts/verify-release-pairing.sh --published\n" + CI_STEP_HEADER,
     CLASS_DIGEST),
    ("a call site added to the Makefile on an unpinned line", "Makefile",
     "test: test-unit\n",
     "bash scripts/verify-release-workflows.sh --self-test\ntest: test-unit\n",
     CLASS_SWEEP),
    ("a workflow-level key added above `jobs:`", ".github/workflows/ci.yml",
     CI_HEAD,
     "name: CI\nenv:\n  FOO: bar\n\non:\n",
     CLASS_DIGEST),
    ("a second root-level `jobs:` mapping added below the first", ".github/workflows/ci.yml",
     "      - name: Run full rubric\n        run: make rubric\n",
     "      - name: Run full rubric\n        run: make rubric\n"
     "jobs:\n  decoy:\n    name: Release/security gates\n    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("a job-level key added to a pinned job", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    timeout-minutes: 1\n    runs-on: ubuntu-latest\n",
     CLASS_DIGEST),
    ("a sibling step added to a pinned job", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     "      - name: Extra unguarded helper\n"
     "        run: bash scripts/verify-api-snapshots.sh\n" + CI_GUARD_BARE + META_GUARD_BODY_FIRST,
     CLASS_DIGEST),
    ("the pinned job key defined a second time", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    if: false\n    runs-on: ubuntu-latest\n  release-please:\n",
     CLASS_DIGEST),
)


# ---------------------------------------------------------------------------
# Round 6: the collapse completed. Rounds 1-5 pinned *regions* inside the five
# workflows, which left every root key below `jobs:`, every key spelling YAML
# resolves to a pinned key, and every script below the pinned steps outside the
# pins. The five workflows are whole-file digests now and the release path is a
# digest closure, so every case below fails on a pin rather than on a rule about
# YAML or bash. Each is a repro from the adversarial review of round 5
# (head b12f6d4a) - R5-1 .. R5-5 - or the battery row the runbook was missing
# (R5-6), plus the closure row this construction carries.
# ---------------------------------------------------------------------------

ROUND_6_ATTACKS = (
    # R5-1 - a root key below `jobs:` was outside every pin. `env: BASH_ENV` sources an
    # attacker's file into every bash step of every job, including the pinned gate steps;
    # a root-level `defaults: run: shell:` replaces the shell of every `run:` step. Both
    # are appended at EOF, which the trailing unpinned `pages-dispatch` job absorbed.
    ("R5-1 root-level `env: BASH_ENV` appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "env:\n  BASH_ENV: ./weaken.sh\n", CLASS_DIGEST),
    ("R5-1 root-level `defaults.run.shell` appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n", CLASS_DIGEST),
    ("R5-1 root-level `defaults.run.shell` appended at release.yml EOF", ".github/workflows/release.yml",
     RELEASE_TAIL, RELEASE_TAIL + "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n", CLASS_DIGEST),
    # R5-2 - key identity is not byte identity. YAML reads `"jobs":`, `jobs :` and `jobs:` as
    # the same key and keeps the last mapping, so a quoted shadow, a quoted duplicate job key
    # and a space-drifted duplicate all resolved to a definition the guard had never read.
    ("R5-2 quoted `\"jobs\":` shadow mapping appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL
     + '"jobs":\n  decoy:\n    name: Release/security gates\n    runs-on: ubuntu-latest\n    steps: []\n',
     CLASS_DIGEST),
    ("R5-2 quoted duplicate job key appended inside the ci.yml `jobs:` mapping",
     ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + '  "release-security-gates":\n    name: Decoy release/security gates\n'
     "    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("R5-2 space-drifted duplicate job key inside the ci.yml `jobs:` mapping",
     ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + "  release-security-gates :\n    name: Decoy release/security gates\n"
     "    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("R5-2 quoted duplicate `\"release-please\":` job key in release.yml", ".github/workflows/release.yml",
     RELEASE_TAIL, RELEASE_TAIL + '  "release-please":\n    runs-on: ubuntu-latest\n    steps: []\n',
     CLASS_DIGEST),
    # R5-4 - the YAML 1.1 boolean alias: `true:` and `on:` are one key to PyYAML, so a `true:`
    # block below `jobs:` could redefine the value the workflow is keyed on.
    ("R5-4 root-level `true:` block appended below `jobs:` in ci.yml", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "true:\n  cancel-in-progress: true\n", CLASS_DIGEST),
    # R5-3 - the publish path below the pinned steps was substring-guarded only. Wrapping the
    # branch-provenance call in `if false` left every needle present and correctly ordered
    # while the pairing gate stopped running on every tagged publish.
    ("R5-3 `if false` wrap of the branch-provenance call in publish-release-assets.sh",
     "scripts/publish-release-assets.sh",
     'else\n  scripts/verify-release-branch.sh "${tag}"\nfi\n',
     'else\n  if false; then\n    scripts/verify-release-branch.sh "${tag}"\n  fi\nfi\n',
     CLASS_DIGEST),
    # R5-5 - a tolerance that is not semantics-preserving, and the two normalisations the
    # construction used to tolerate. They are byte changes now, like anything else.
    ("R5-5 trailing whitespace after a backslash continuation in a pinned workflow",
     ".github/workflows/ci.yml",
     '          git fetch --no-tags "${release_ref_depth_args[@]}" origin \\\n',
     '          git fetch --no-tags "${release_ref_depth_args[@]}" origin \\ \n',
     CLASS_DIGEST),
    ("R5-5 trailing whitespace on a pinned step line", ".github/workflows/ci.yml",
     CI_SELF_TEST, CI_SELF_TEST.rstrip("\n") + "   \n", CLASS_DIGEST),
    ("R5-5 trailing whitespace on a pinned release-path script line", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE.rstrip("\n") + "   \n", CLASS_DIGEST),
    ("R5-5 CRLF line endings in a pinned workflow", ".github/workflows/ci.yml",
     CI_HEAD, lambda text: text.replace("\n", "\r\n"), CLASS_DIGEST),
    ("R5-5 CRLF line endings in a pinned release-path script", "scripts/verify-release-gates.sh",
     "#!/usr/bin/env bash\n", lambda text: text.replace("\n", "\r\n"), CLASS_DIGEST),
    ("R5-5 byte-order mark prepended to a pinned workflow", ".github/workflows/ci.yml",
     "name: CI\n", "\ufeffname: CI\n", CLASS_DIGEST),
    # R5-6 - the runbook carried a row for an action reference changed inside a pinned job and
    # no battery case behind it. The row stays; the case exists now.
    ("R5-6 action reference changed inside a pinned job", ".github/workflows/ci.yml",
     "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n",
     "      - uses: actions/setup-go@main # v7.0.0\n",
     CLASS_DIGEST),
    # The closure row: a pinned workflow that names a script nothing pins. It fails on the
    # digest of the workflow it edits and on the closure, which is the class of that row.
    ("the closure row: a pinned workflow names a script pinned by nothing", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "      - name: Closure probe\n        run: bash scripts/verify-ssr-site-smoke.sh\n",
     CLASS_CLOSURE),
    # The round-5 disclosure moved into the interior. At round 5 these two files were read by
    # nothing and were disclosed as unpinned; ci.yml invokes both, so both are in the closure
    # now and an edit to either is a digest finding like any other. Two accepted cases became
    # two attack cases, and the disclosed set is one file - this guard.
    ("the closed boundary: an edit to verify-ci-rubric-enforced.sh",
     "scripts/verify-ci-rubric-enforced.sh",
     'require_contains "${ci}" "bash scripts/verify-release-workflows.sh" \\\n',
     'require_contains "${ci}" "bash scripts/verify-branch-release-supply-chain.sh" \\\n',
     CLASS_DIGEST),
    ("the closed boundary: an edit to the paired gate's own file", "scripts/verify-release-pairing.sh",
     "set -euo pipefail\n", "set -euo pipefail\necho tampered\n", CLASS_DIGEST),
)

SELF_TEST_ATTACKS = (
    ROUND_4_ATTACKS + ROUND_4_ACCEPTED_RECYCLED + ROUND_5_ATTACKS + ROUND_6_ATTACKS
)


def _accepted_makefile(source):
    source["Makefile"] = source["Makefile"].replace(
        "test: test-unit\n", "bash scripts/verify-release-workflows.sh\ntest: test-unit\n", 1
    )
    return source


def _accepted_new_workflow(source):
    source[".github/workflows/pages-preview.yml"] = (
        "name: Pages preview\n\non:\n  workflow_dispatch:\n\njobs:\n  preview:\n"
        "    runs-on: ubuntu-latest\n    steps:\n      - run: echo preview\n"
    )
    return source


def _accepted_new_job(source):
    source[".github/workflows/pages.yml"] = source[".github/workflows/pages.yml"] + (
        "\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preview\n"
    )
    return source


def _accepted_guard_own_file(source):
    source[GUARD_PATH] = source[GUARD_PATH].replace(
        "GUARDED_BASENAMES = ", "GUARDED_BASENAMES = ()  # tampered\n", 1
    )
    return source


# The shapes that must stay accepted, so a construction that over-blocks fails the self-test
# as loudly as one that starts missing. Every admitted shape is additive: it adds a workflow,
# adds a job to a file no pin covers, or repeats a pinned invocation line. None of them can
# change a byte of a pinned file, and none can stop a pinned step from running. One entry is
# the disclosure - this guard is read by nothing here - and the battery asserts that boundary
# rather than leaving it claimed in prose only.
SELF_TEST_ACCEPTED = (
    (
        "a byte-identical pinned invocation line added to the Makefile",
        _accepted_makefile,
    ),
    (
        "a new unguarded workflow added under .github/workflows",
        _accepted_new_workflow,
    ),
    (
        "a new unguarded job added to an unpinned workflow",
        _accepted_new_job,
    ),
    (
        "the disclosed boundary: the guard's own file is read by nothing",
        _accepted_guard_own_file,
    ),
)


def fixture_paths():
    paths = set(sweep_paths())
    paths.update(PINNED_FILE_DIGESTS)
    paths.add(GUARD_PATH)
    return tuple(sorted(paths))


def run_self_test() -> None:
    fixture = {path: read_source(path) for path in fixture_paths()}
    base_sweep = sweep_paths()

    def read_from(source):
        def read_text(path):
            if path not in source:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test read {path!r} outside the fixture set)"
                )
            return source[path]

        return read_text

    def sweep_for(source):
        # The sweep set the real run would use, plus any file an accepted case adds. The
        # guard's own file is in the fixture but is never swept, exactly as in the real run.
        return tuple(sorted(set(base_sweep) | (set(source) - set(fixture))))

    baseline = guarded_surface_findings(read_from(fixture), sweep=sweep_for(fixture))
    if baseline:
        raise SystemExit(
            "release-workflows: FAIL (self-test: the legitimate guarded wiring was REJECTED, so the "
            "guard over-blocks: " + "; ".join(message for _kind, message in baseline)
        )
    print("release-workflows: PASS-PROOF (self-test accepted: the legitimate guarded wiring at HEAD)")

    for label, path, anchor, replacement, expected in SELF_TEST_ATTACKS:
        source = dict(fixture)
        if anchor not in source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} anchor is missing "
                f"from {path})"
            )
        mutated = (
            replacement(source[path])
            if callable(replacement)
            else source[path].replace(anchor, replacement, 1)
        )
        if mutated == source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                f"nothing in {path})"
            )
        source[path] = mutated
        findings = guarded_surface_findings(read_from(source), sweep=sweep_for(source))
        if not findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test MISSED the {label!r} weakening in {path})"
            )
        kinds = {kind for kind, _message in findings}
        if expected not in kinds:
            joined = " | ".join(f"{kind}: {message}" for kind, message in findings)
            raise SystemExit(
                f"release-workflows: FAIL (self-test caught the {label!r} weakening but reported an "
                f"unexpected diagnostic; expected {expected!r} in {joined!r})"
            )
        print(f"release-workflows: FAIL-PROOF (self-test rejected: {label} in {path} -> {expected})")

    for label, mutate in SELF_TEST_ACCEPTED:
        source = mutate(dict(fixture))
        if source == fixture:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                f"nothing)"
            )
        findings = guarded_surface_findings(read_from(source), sweep=sweep_for(source))
        if findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test OVER-BLOCKS the accepted shape {label!r}: "
                + "; ".join(message for _kind, message in findings)
            )
        print(f"release-workflows: ACCEPT-PROOF (self-test accepted: {label})")

    print(
        f"release-workflows: PASS (self-test: {len(SELF_TEST_ATTACKS)} weakening shape(s) failed closed, "
        f"{len(SELF_TEST_ACCEPTED)} fail-closed spelling(s) accepted, the legitimate wiring accepted)"
    )


if MODE == "self-test":
    run_self_test()
    raise SystemExit(0)

# The runbook states three counts in prose: the two battery counts and the size of the pinned
# closure. Reflowed line breaks are normal in Markdown and are not drift, so the document is
# compared with its whitespace collapsed; every number is read out of the artifact that
# produces it, never restated.
_doc_text = " ".join(Path("docs/release-process.md").read_text(encoding="utf-8").split())
for _doc_claim in (
    f"{len(SELF_TEST_ATTACKS)} weakening shapes fail closed and "
    f"{len(SELF_TEST_ACCEPTED)} fail-closed spellings are accepted",
    f"the transitive closure of the script paths they name: "
    f"{len(RELEASE_PATH_FILE_DIGESTS)} files under `scripts/` and `gov-infra/`",
):
    if _doc_claim not in _doc_text:
        raise SystemExit(
            "release-workflows: FAIL (docs/release-process.md must state what the pins actually cover - "
            "the battery counts and the size of the closure - so a documented claim cannot drift from "
            f"the artifact behind it; missing {_doc_claim!r})"
        )

guarded_surface = guarded_surface_findings(read_source)
if guarded_surface:
    raise SystemExit(
        "release-workflows: FAIL (a guarded release-gate region is not its pinned revision; "
        + "; ".join(message for _kind, message in guarded_surface) + ")"
    )
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Release Please (Prerelease)",
    "prerelease creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/release.yml",
    "Verify branch version sync (stable release preflight)",
    "Release Please (Stable)",
    "stable release creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/prerelease.yml",
    "Release Please (Prerelease)",
    "Verify prerelease publish postcondition",
    "prerelease publisher must validate release-please outputs before asset publishing",
)
require_order(
    ".github/workflows/release.yml",
    "Release Please (Stable)",
    "Verify stable publish postcondition",
    "stable publisher must validate release-please outputs before asset publishing",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "concurrency:\n  group: release-publisher-${{ github.repository }}\n  cancel-in-progress: false",
        "release publisher workflows must share one non-cancelling concurrency group",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "release publisher workflows must queue reruns and workflow_dispatch events instead of cancelling an active publisher",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "release publisher concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "permissions:",
        "release publisher concurrency must be declared before jobs so the whole publisher workflow is serialized",
    )
release_pr_concurrency = {
    ".github/workflows/prerelease-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--premain\n"
        "  cancel-in-progress: false"
    ),
    ".github/workflows/release-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--main\n"
        "  cancel-in-progress: false"
    ),
}
for workflow, snippet in release_pr_concurrency.items():
    require_contains(
        workflow,
        snippet,
        "generated release PR workflows must serialize per release PR without cancelling an active sync",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "generated release PR workflows must queue overlapping runs instead of cancelling an active sync",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "generated release PR concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "jobs:",
        "generated release PR concurrency must be declared before jobs so PR sync is serialized",
    )
release_please_draft_guard = (
    "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false || "
    "(github.event.pull_request.head.ref != 'release-please--branches--premain' && "
    "github.event.pull_request.head.ref != 'release-please--branches--main')"
)
for job in ("version-alignment", "go", "ts", "py", "contract-tests"):
    require_job_contains(
        ".github/workflows/ci.yml",
        job,
        release_please_draft_guard,
        "required CI checks must not evaluate draft release-please heads before generated artifacts are synced",
    )
require_not_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main'\n",
    "workflow_dispatch existing-tag uploads must not run stable main preflight from branch HEAD",
)
require_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
    "stable release branch preflight must be skipped for workflow_dispatch existing-tag uploads",
)
require_not_contains(
    ".github/workflows/release.yml",
    "ref: ${{ steps.release.outputs.tag_name }}",
    "stable release asset build must not assume release-please draft releases have materialized git tags",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        "release workflows must publish assets through the shared draft-release-safe path",
    )
    require_not_contains(
        workflow,
        "make rubric",
        "release publisher workflows must use release hygiene and publish postconditions instead of the full rubric",
    )
require_contains(
    ".github/workflows/prerelease.yml",
    "scripts/verify-release-publish-postcondition.sh prerelease",
    "prerelease publisher must fail closed when a generated RC release PR merge does not create an RC release",
)
require_contains(
    ".github/workflows/release.yml",
    "scripts/verify-release-publish-postcondition.sh stable",
    "stable publisher must fail closed when a generated stable release PR merge does not create a stable release",
)
require_contains(
    ".github/workflows/prerelease.yml",
    "Recover or verify existing prerelease",
    "prerelease reruns must recover drafts and verify already-published immutable releases",
)
require_contains(
    ".github/workflows/release.yml",
    "Recover or verify existing stable release",
    "stable reruns must recover drafts and verify already-published immutable releases",
)
for workflow, channel, closure_step in (
    (".github/workflows/prerelease.yml", "prerelease", "Verify prerelease publication closure"),
    (".github/workflows/release.yml", "stable", "Verify stable publication closure"),
):
    require_not_contains(
        workflow,
        "--json isDraft",
        "release reruns must verify already-published releases instead of skipping non-drafts",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" prepublish',
        "release workflows must validate Release Please output before the publisher mutates tag state",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" complete',
        "release workflows must prove Go module publication closure after the publisher",
    )
    require_order(
        workflow,
        "prepublish",
        closure_step,
        "release workflows must run the prepublish gate before the complete publication postcondition",
    )
    require_order(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        closure_step,
        "release workflows must finish the serialized publisher before the complete postcondition",
    )
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "scripts/diagnose-release-state.sh --tag",
        "failed release publisher jobs must print read-only release diagnostics",
    )
require_contains(
    ".github/workflows/release.yml",
    "- name: Diagnose failed release state (read-only)\n        if: failure()",
    "stable diagnostics must run for main, tag, and workflow_dispatch publisher failures",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: branch=",
    "release diagnostics must print the current branch and head",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: tag=",
    "release diagnostics must print the active tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "go-module-tag=",
    "release diagnostics must report nested Go module tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "cut a new version",
    "release diagnostics must refuse repair by moving a conflicting immutable module tag",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: release=",
    "release diagnostics must print GitHub Release state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: manifests:",
    "release diagnostics must print manifest state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: safe-next-action=",
    "release diagnostics must print the safe next action",
)
for forbidden in (
    "gh release upload",
    "gh release edit",
    "gh release create",
    "gh release delete",
    "gh release delete-asset",
):
    require_not_contains(
        "scripts/diagnose-release-state.sh",
        forbidden,
        "release diagnostics must not mutate GitHub Releases",
    )
require_contains(
    "scripts/publish-release-assets.sh",
    'git fetch "${remote}" "${main_branch}" "${premain_branch}" --tags --force',
    "release asset publisher must fetch branch and tag refs before provenance checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    'scripts/verify-release-branch.sh "${tag}"',
    "scripts/verify-version-alignment.sh",
    "release asset publisher must verify the resolved source before version/package checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/verify-version-alignment.sh",
    "make build",
    "release asset publisher must verify version alignment before building release assets",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "make rubric",
    "release asset publisher must not run the full rubric",
)
require_order(
    "scripts/publish-release-assets.sh",
    "make build",
    "scripts/generate-checksums.sh",
    "release asset publisher must build dist artifacts before generating checksums",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    'gh release upload "${tag}"',
    "release asset publisher must checksum artifacts before upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    "release asset publisher must finish deterministic source builds before creating module tags",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
    "release asset publisher must create immutable module tags before exact resolution",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release upload "${tag}"',
    "release asset publisher must prove Go modules before uploading draft assets",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must prove Go modules before publication becomes visible",
)
for path in (
    "scripts/go-module-release-contract.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
):
    require_contains(
        "scripts/verify-branch-release-supply-chain.sh",
        path,
        f"release supply-chain verifier must require {path}",
    )
for forbidden in (
    "git push --force",
    "git push -f",
    "git tag -f",
    "git push --delete",
):
    require_not_contains(
        "scripts/publish-go-module-tags.sh",
        forbidden,
        "Go module tag publisher must never move or delete an existing tag",
    )
require_contains(
    "scripts/publish-go-module-tags.sh",
    "refs are immutable",
    "Go module tag publisher must fail closed on a conflicting existing ref",
)
require_contains(
    "scripts/publish-go-module-tags.sh",
    "concurrently created",
    "Go module tag publisher must safely accept a same-SHA create race",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    "GOPROXY=direct",
    "Go module postcondition must bypass stale proxy state and resolve the exact Git refs",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Hash")',
    "Go module postcondition must prove the resolved commit hash",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Ref")',
    "Go module postcondition must prove the root or nested tag ref",
)
require_contains(
    "scripts/publish-release-assets.sh",
    '--clobber',
    "release asset publisher must replace any existing draft assets during recovery",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "is already published; immutable releases prevent adding assets/notes",
    "release asset publisher reruns must verify published immutable assets instead of failing before integrity checks",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "verify_published_release_assets",
    "release asset publisher must verify immutable assets when a rerun finds the release already published",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "published release is missing immutable asset",
    "release asset publisher must fail closed when a published release is missing an expected asset",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "does not match source build",
    "release asset publisher must fail closed when a published release asset checksum differs from the source build",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "already published with matching immutable assets",
    "release asset publisher must skip safely when rerun after successful publication",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "release-assets: skip existing",
    "release asset publisher must not trust existing draft assets by filename",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "release asset publisher must enumerate source-built assets after checksums are generated",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "verify_published_release_assets",
    'gh release upload "${tag}" "${asset_path}" --clobber',
    "release asset publisher must verify-and-skip published releases before any clobbering draft upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'if ! gh release upload "${tag}" "${asset_path}" --clobber; then',
    "verify_published_release_assets",
    "failed to upload draft asset",
    "release asset publisher must re-check immutable publication races before failing an upload rerun",
)
require_order(
    "scripts/publish-release-assets.sh",
    'gh release upload "${tag}"',
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must upload assets before publishing the immutable release",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    'git fetch "${remote}" tag "${tag}" --force',
    'scripts/verify-release-branch.sh "${tag}"',
    "release asset publisher must verify the materialized tag after publishing",
)
require_contains(
    "scripts/verify-release-branch.sh",
    "ALLOW_UNTAGGED_DRAFT_RELEASE",
    "release branch verifier must only allow missing tag refs for explicitly verified draft releases",
)
require_order(
    "scripts/verify-release-branch.sh",
    'tag_commit="$(git rev-parse "${DRAFT_RELEASE_TARGET}^{commit}")"',
    'if [[ "${commit}" != "${tag_commit}" ]]',
    "release branch verifier must compare HEAD to the tag or draft target commit before allowing asset builds",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "union ranges are not verified",
    "template/release pairing verifier must fail closed on range syntax it cannot decide",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "release candidate packed at the wrong version",
    "template/release pairing verifier must reject a CDK tarball packed at a version other than VERSION",
)
require_contains(
    "scripts/verify-release-branch.sh",
    'scripts/verify-release-pairing.sh --tag "${expected_tag}"',
    "release branch verifier must pair apptheory-init templates with the release-candidate CDK tarball before assets are built",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must pair the published release CDK asset with the shipped templates",
)
require_order(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${phase}" != "complete" ]]',
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must only pair against the published asset once publication completes",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${release_created}" != "true" ]]; then\n    return 0\n  fi\n\n  # Post-publish leg',
    "publish postcondition verifier must pair only the release created by the run, not a republished older release",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-pairing.sh",
    "full release gates must pair apptheory-init templates with the release-candidate CDK tarball",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-pairing.sh",
    "CI release/security gates must run the template/release pairing verifier",
)
for release_pr_workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        release_pr_workflow,
        "bash scripts/verify-release-pairing.sh",
        f"{release_pr_workflow} must pair apptheory-init templates with the release-candidate CDK tarball before generated artifact sync",
    )
    require_order(
        release_pr_workflow,
        "Verify apptheory-init template/release pairing",
        "Sync generated CDK artifacts on release PR",
        f"{release_pr_workflow} must fail closed on template/release skew before syncing generated CDK artifacts",
    )
require_contains(
    ".github/workflows/ci.yml",
    "ready_for_review",
    "CI must run when humans mark draft release PRs ready",
)
require_contains(
    ".github/workflows/ci.yml",
    "workflow_dispatch:\n    inputs:\n      run_full_rubric:",
    "CI must be dispatchable for bot-authored release PR branch updates with explicit rubric control",
)
require_contains(
    ".github/workflows/ci.yml",
    "default: true",
    "manual CI workflow_dispatch must continue to run the full rubric by default",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_pr_number:\n        description: "Generated release PR number for head-bound release checks"',
    "generated release CI dispatch must identify the exact release PR",
)
require_contains(
    ".github/workflows/ci.yml",
    "github.event_name == 'workflow_dispatch' && inputs.release_pr_number != ''",
    "release promotion verification must run inside generated release CI dispatches",
)
require_contains(
    ".github/workflows/ci.yml",
    "permissions:\n  contents: read\n  pull-requests: read",
    "head-bound release CI dispatch must have read-only pull request metadata access",
)
require_contains(
    ".github/workflows/ci.yml",
    'if [[ "${PR_HEAD_REF}" != "${DISPATCH_HEAD_REF}" || "${PR_HEAD_SHA}" != "${DISPATCH_HEAD_SHA}" ]]; then',
    "release promotion dispatch must bind the requested PR to the dispatched branch and SHA",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')",
    "full rubric must run only on staging PRs and opted-in manual dispatch",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Verify deterministic builds",
    "CI must keep the standalone deterministic-build job name stable",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'",
    "deterministic builds must run only on staging PRs",
)
require_contains(
    ".github/workflows/ci.yml",
    "Release train promotion gate",
    "CI must gate release train promotion PRs before release state can advance",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-train-promotion.sh",
    "CI must run the release train promotion verifier",
)
require_contains(
    ".github/workflows/ci.yml",
    "ref: refs/heads/staging",
    "release train promotion verifier must run from trusted protected release gate code",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "release train promotion verifier must not execute verifier code from the untrusted PR head",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "refs/pull/${PR_NUMBER}/head:${pr_head_data_ref}",
    "release train promotion verifier must not fetch untrusted PR head content in CI",
)
require_contains(
    ".github/workflows/ci.yml",
    "GITHUB_TOKEN: ${{ github.token }}",
    "release train promotion verifier must use the read-only workflow token for compare API ancestry checks",
)
require_contains(
    ".github/workflows/ci.yml",
    "base_ref_args=(--base-ref \"refs/remotes/origin/${PR_BASE_REF}\")",
    "release train promotion verifier must use fetched protected base refs instead of PR-head checkout data",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_ref_depth_args=(--unshallow)',
    "release train promotion verifier must unshallow trusted protected release branch history",
)
for branch in ("staging", "premain", "main"):
    require_contains(
        ".github/workflows/ci.yml",
        f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        f"release train promotion verifier must fetch protected {branch} history for topology checks",
    )
require_contains(
    ".github/workflows/ci.yml",
    '--head-sha "${PR_HEAD_SHA}"',
    "release train promotion verifier must pass the event head SHA without fetching PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    'pr_title_args=(--pr-title "${PR_TITLE}")',
    "release train promotion verifier must pass PR titles when trusted verifier code supports title checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-repository "${GITHUB_REPOSITORY}"',
    "release train promotion verifier must identify the protected repository for compare checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-head-repository "${PR_HEAD_REPOSITORY}"',
    "release train promotion verifier must compare fork PR heads in their source repository",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "--head-ref HEAD",
    "release train promotion verifier must not trust the checkout HEAD as release PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    "persist-credentials: false",
    "release train promotion checkout must not persist credentials",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    'ancestor_branch="premain", descendant_branch=head',
    "prerelease promotion verifier must topology-check staging to premain promotions",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted {remote}/{branch}",
    "release train promotion verifier must reject forged release branch head content",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "compare/{ancestor_sha}...{descendant_sha}",
    "release train promotion verifier must use GitHub compare data for untrusted PR head ancestry",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "refs/remotes/origin/pr/1/head",
    "release train promotion self-test must cover fetched PR head data that forges a release branch name",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "staging → premain → main → staging",
    "release train promotion verifier must preserve the single valid branch ordering",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--premain",
    "release train promotion verifier must allow generated premain RC release-please PRs only on premain",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--main",
    "release train promotion verifier must allow generated main stable release-please PRs only on main",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "must originate from trusted repository",
    "release train promotion verifier must reject forked generated release-please branch spoofing",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "event head SHA is required to verify generated release-please branch",
    "release train promotion verifier must require exact release-please head SHA provenance",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted origin/release-please--branches--premain",
    "release train promotion self-test must reject forged release-please head SHA",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "main release gate rejects RC-shaped PR titles/versions",
    "main release promotion gate must reject RC-shaped main PR titles/versions",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Release/security gates",
    "CI must expose release/security gates as a stable non-skipped branch-protection context",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-train-promotion.sh --self-test",
    "CI release/security gates must exercise release train provenance self-tests",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-ci-rubric-enforced.sh",
    "CI release/security gates must verify rubric enforcement separately from the full rubric",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-runtime-floor-claims.sh",
    "CI release/security gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-train-promotion.sh --self-test",
    "full release gates must include release train provenance self-tests",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-cycle.sh",
    "full release gates must include deterministic full-cycle release regression",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-runtime-floor-claims.sh",
    "full release gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-cycle.sh",
    "REQUIRED_COVERAGE",
    "release cycle verifier must declare required coverage cases",
)
for coverage in (
    "happy_path",
    "go_module_tags",
    "publish_recovery_race",
    "stale_release_please_pr",
    "promotion_drift",
    "back_merge_drift",
):
    require_contains(
        "scripts/verify-release-cycle.sh",
        coverage,
        f"release cycle verifier must cover {coverage}",
    )
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-branch-version-sync.sh",
    "CI must run the branch release-version sync verifier with git metadata",
)
require_order(
    ".github/workflows/prerelease-pr.yml",
    "Verify branch version sync before release PR",
    "Release Please (PR only)",
    "prerelease PR generation must fail closed before opening stale release-please PRs",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "scripts/run-release-please-pr.sh",
        "release PR workflows must create release-please PRs through the stale-state-tolerant wrapper",
    )
require_not_contains(
    "scripts/run-release-please-pr.sh",
    'valid release PR already exists',
    "release-please PR generation must not short-circuit before release-please can refresh stale open PRs",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "draft_lock_existing_open_release_pr_before_refresh",
    "bash scripts/invoke-release-please-pr.sh",
    "release-please PR generation may draft-lock already-open PRs but must still invoke release-please",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "bash scripts/invoke-release-please-pr.sh",
    'if use_existing_open_release_pr "release-please exited ${release_please_status} after creating or finding a release PR"; then',
    "release-please PR generation must recover when stale release-please state errors after a valid PR exists",
)
require_not_contains(
    "scripts/run-release-please-pr.sh",
    "--token",
    "release-please credentials must never be forwarded through npm or shell process arguments",
)
require_contains(
    "scripts/run-release-please-pr.sh",
    'gh pr ready "${pr_number}" --undo',
    "release-please PR generation must draft-lock valid open release PRs before artifact setup",
)
for workflow, step_name in (
    (".github/workflows/prerelease-pr.yml", "Release Please (PR only)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only) (aligned)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only)"),
):
    require_step_contains(
        workflow,
        step_name,
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release-please wrapper steps must authenticate gh CLI with the release token fallback",
    )
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Verify release workflow invariants (release preflight)",
    "prerelease creation must fail closed on stale branch release state before release workflow checks",
)
require_order(
    ".github/workflows/prerelease.yml",
    "actions/setup-go",
    "Verify release workflow invariants (release preflight)",
    "prerelease workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_order(
    ".github/workflows/release.yml",
    "actions/setup-go",
    "Verify release workflow invariants (stable release preflight)",
    "stable workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_contains(
    ".github/workflows/prerelease-pr.yml",
    "scripts/verify-release-pr-postcondition.sh prerelease",
    "prerelease PR generation must fail closed when release-please no-ops",
)
require_contains(
    ".github/workflows/release-pr.yml",
    "scripts/verify-release-pr-postcondition.sh stable",
    "stable Release PR generation must fail closed when release-please no-ops",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "parse_version_value",
    "release PR postcondition verifier must parse annotated VERSION values before shape validation",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "1.12.2-rc # x-release-please-version",
    "release PR postcondition verifier self-test must cover annotated RC VERSION values",
)
require_contains(
    "docs/release-process.md",
    "watch the first generated",
    "release process runbook must keep an evidence-bounded first-RC watch for release-please extra-files changes",
)
require_contains(
    "docs/release-process.md",
    "CI is not a signing key holder",
    "release process runbook must document the no-CI-signing-secrets policy",
)
require_contains(
    "docs/release-process.md",
    "local_status=N",
    "release process runbook must distinguish local unresolved SSH verification from GitHub verified-valid evidence",
)
for forbidden in (
    "RELEASE_ARTIFACT_SYNC_" + "GPG",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_" + "PRIVATE" + "_KEY",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_KEY_ID",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_PASSPHRASE",
):
    for path in (
        ".github/workflows/prerelease-pr.yml",
        ".github/workflows/release-pr.yml",
        "scripts/render-release-artifact-sync-plan.py",
        "scripts/sync-release-pr-generated.sh",
        "docs/release-process.md",
    ):
        require_not_contains(
            path,
            forbidden,
            "release artifact sync must not depend on CI-held signing secrets",
        )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--raw-field run_full_rubric=false",
    "automated release PR CI dispatch must disable the full rubric",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--raw-field release_pr_number="${pr_number}"',
    "automated release PR CI dispatch must bind checks to the exact release PR",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "Release train promotion gate\nRelease/security gates",
    "release PR sync must wait for promotion and release/security checks in the single dispatched run",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Rubric (full gate set)",
    "release PR sync required checks must exclude the full rubric context",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Verify deterministic builds",
    "release PR sync required checks must exclude skipped deterministic-build contexts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo',
    "release PR sync must force the release PR back to draft before generated artifact work",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--local-signed-sync",
    "release PR sync must retain an explicit offline local signed artifact sync fallback",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_message="chore(release): sync generated release artifacts"',
    "release PR sync must use one stable generated artifact sync commit message",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_body="[skip ci]"',
    "generated artifact commits must suppress redundant pull_request CI events",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"body": args.body',
    "GitHub-created generated artifact commits must carry the automatic-event suppression marker",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--body "${artifact_sync_commit_body}"',
    "release PR sync must pass the automatic-event suppression marker into the GitHub commit plan",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -m "${artifact_sync_commit_message}" -m "${artifact_sync_commit_body}"',
    "local signed release PR sync fallback must use normal local git commit signing configuration",
)
require_contains(
    "scripts/invoke-release-please-pr.mjs",
    '`${options.message}\\n\\n[skip ci]`',
    "release-please commits must suppress redundant pull_request CI events",
)
require_contains(
    "docs/release-process.md",
    "one explicit `workflow_dispatch` CI run",
    "release runbook must document the single-trigger generated release PR contract",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    "createCommitOnBranch",
    "CI release PR sync must create generated artifact commits through GitHub server-side verified automation",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"--no-renames"',
    "GitHub artifact plans must represent module-root moves as explicit additions and deletions",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "github-verified-api",
    "release PR sync self-test must prove CI selects the GitHub-verified API mode",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"expectedHeadOid": args.expected_head',
    "GitHub API generated artifact sync must use optimistic expectedHeadOid concurrency",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "scripts/render-release-artifact-sync-plan.py",
    "release PR sync must use the shared fail-closed artifact plan renderer",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "gh api graphql --input",
    "CI generated artifact sync must send a GraphQL createCommitOnBranch mutation",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "verify_github_synced_head",
    "CI generated artifact sync must fetch and verify the GitHub-created commit before continuing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "push_local_signed_release_artifact_sync",
    "release PR sync must isolate git push to the offline local signed fallback",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "local-signed)",
    "push_local_signed_release_artifact_sync",
    "only the local signed fallback may push a generated artifact commit",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "github-verified-api)",
    "commit_release_artifact_sync_via_github",
    "CI generated artifact sync must use GitHub API commit creation instead of git push",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'scripts/verify-release-branch-signatures.sh',
    "CI generated artifact sync must prove the new release branch commit is accepted by the signature gate",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--range "${expected_head}..${new_head}"',
    "CI generated artifact sync signature proof must scan exactly the created commit range",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -S -m "chore(release): sync generated release artifacts"',
    "release PR sync must not force a bespoke CI signing path",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "gpg --import",
    "release PR sync must not import signing material",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config user.signingkey",
    "release PR sync must not set signing keys",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config gpg.program",
    "release PR sync must not replace the local signing program",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config commit.gpgsign true",
    "release PR sync must not mutate commit-signing configuration",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git verify-commit HEAD",
    "release PR sync must verify generated artifact commit signatures before pushing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git log -1 --format=%G?",
    "release PR sync must report and gate the generated commit signature status",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "GitHub Actions must select createCommitOnBranch sync mode",
    "release PR sync self-test must prove CI uses GitHub-verified product automation instead of a manual stop",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-branch-signatures.sh",
    "release/security gates must scan branch signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "HISTORICAL_UNSIGNED_FIXTURE",
    "release signature gate must have a historical unsigned negative fixture",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "github-verified",
    "release signature gate must distinguish GitHub-verified signatures from local signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "self-test:github-verified-fallback",
    "release signature gate self-test must prove GitHub verified-valid fallback without unsigned commits",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Keep the PR ready only until the required check contexts exist",
    "release PR sync must not depend on recursive pull_request events from bot-authored PR mutations",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "actions: write",
        "release PR workflow must be able to dispatch independent CI for bot-authored branch updates",
    )
    require_not_contains(
        workflow,
        "statuses: write",
        "release PR workflow must not be able to self-attest protected release PR gate statuses",
    )
    require_order(
        workflow,
        "actions/setup-python",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must install Python before running the full release PR gate set",
    )
    require_step_contains(
        workflow,
        "Sync generated CDK artifacts on release PR",
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release PR artifact sync step must authenticate gh without signing secrets",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "actions/setup-go",
        "release PR workflow must draft-lock release PRs before installing artifact-generation toolchains",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must draft-lock release PRs before artifact sync",
    )
require_order(
    "scripts/sync-release-pr-generated.sh",
    'ensure_release_pr_is_draft "before generated artifacts are synced"',
    "scripts/update-cdk-generated.sh",
    "generated artifact sync must draft-lock the release PR before regenerating artifacts",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'git switch --detach "${expected_head}"',
    "sync_stable_release_premain_manifest",
    "scripts/update-cdk-generated.sh",
    "stable premain manifest reset must happen before regenerating artifacts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git add -A",
    "stable release PR sync must commit the premain manifest reset with generated release artifacts",
)
for generated_path in (
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk/lib",
    "cdk-go/go.mod",
    "cdk-go/go.sum",
    "cdk-go/apptheorycdk",
):
    require_contains(
        "scripts/sync-release-pr-generated.sh",
        generated_path,
        f"release PR sync must include {generated_path} in the generated artifact transaction",
    )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "bash scripts/verify-cdk-go.sh",
    "release PR sync must validate generated CDK Go bindings through the nested-module verifier",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "go test ./cdk-go/apptheorycdk",
    "release PR sync must not test the nested cdk-go package from the root Go module",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(git rev-parse HEAD)"',
    "local signed release PR sync must capture the local signed generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    "CI release PR sync must capture the GitHub-created generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="${expected_head}"',
    "release PR sync must preserve the fetched release PR head when generated artifacts are already current",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    "CI release PR sync must verify the GitHub-created generated-artifact head before waiting for it",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    'wait_for_pr_head "${synced_head}"',
    "release PR sync must prove the GitHub-created commit signature before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'wait_for_pr_head "${synced_head}"',
    "After the generated-artifact head is visible",
    "release PR sync must wait for the pushed artifact commit before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "After the generated-artifact head is visible",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "release PR sync must dispatch and wait for independent CI after the generated-artifact head is visible",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "check-runs?per_page=100",
    "release PR sync must read commit check-runs because workflow_dispatch checks are not always surfaced by PR checks",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "COMMIT_CHECKS_JSON",
    "release PR sync must merge commit-attached check-runs into the required check view",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "headSha",
    "release PR sync must only pass required checks attached to the current PR head",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "wait_for_required_checks",
    'require_pr_head "${synced_head}" "after required checks passed"',
    "release PR must re-check the generated-artifact head after required checks pass",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'require_pr_head "${synced_head}" "after required checks passed"',
    'if ! gh pr ready "${pr_number}"; then',
    "release PR must wait for required checks before becoming ready",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'current_pr_state}" != "OPEN" && "${current_pr_state}" != "MERGED"',
    "release PR sync must keep checking required contexts if an externally merged release PR is already terminal",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "already merged after generated artifacts and required checks matched",
    "release PR sync must treat an externally merged synced PR as a benign terminal state after checks pass",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo || true',
    "release PR sync must restore draft state if the PR head changes while becoming ready",
)
for forbidden in (
    "repos/${GITHUB_REPOSITORY}/statuses",
    "set_release_pr_status",
    "run_release_pr_status_check",
    "run_release_pr_required_checks",
):
    require_not_contains(
        "scripts/sync-release-pr-generated.sh",
        forbidden,
        "release PR sync must not self-attest protected contexts",
    )

subprocess.run(["bash", "scripts/verify-branch-version-sync.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-pr-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-publish-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/publish-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/render-release-notes.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/diagnose-release-state.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/sync-release-pr-generated.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-please-token-safety.sh"], check=True)

print("release-workflows: PASS")
PY
