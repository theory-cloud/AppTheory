#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

expected_version="$(./scripts/read-version.sh)"
expected_py_version="${expected_version}"
if [[ "${expected_py_version}" == *"-rc."* ]]; then
  expected_py_version="${expected_py_version/-rc./rc}"
fi

epoch="${SOURCE_DATE_EPOCH:-}"
if [[ -z "${epoch}" ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    epoch="$(git show -s --format=%ct HEAD)"
  else
    epoch="0"
  fi
fi

export SOURCE_DATE_EPOCH="${epoch}"

mkdir -p dist

if [[ ! -d "cdk/.venv" ]]; then
  python3 -m venv cdk/.venv
fi

cdk/.venv/bin/python -m pip install --upgrade pip >/dev/null
cdk/.venv/bin/python -m pip install --requirement cdk/requirements-build.txt >/dev/null

tmp_dir="$(mktemp -d)"
tmp_log="$(mktemp)"
cleanup() {
  rm -rf "${tmp_dir}"
  rm -f "${tmp_log}"
}
trap cleanup EXIT

cp -a cdk "${tmp_dir}/cdk"

TMP_CDK_DIR="${tmp_dir}/cdk" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
root = Path(os.environ["TMP_CDK_DIR"])
for file_path in root.rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY

(cd "${tmp_dir}/cdk" && npm ci >/dev/null)
(cd "${tmp_dir}/cdk" && npm run build >/dev/null)

TMP_CDK_DIR="${tmp_dir}/cdk" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
root = Path(os.environ["TMP_CDK_DIR"])
for file_path in root.rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY

(cd "${tmp_dir}/cdk" && npx jsii-pacmak -t python --code-only -o "${tmp_dir}/python" --force-subdirectory false --force >/dev/null)

cp LICENSE "${tmp_dir}/python/LICENSE"

TMP_PY_DIR="${tmp_dir}/python" python3 - <<'PY'
import os
from pathlib import Path

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
root = Path(os.environ["TMP_PY_DIR"])
for file_path in root.rglob("*"):
  if file_path.is_file():
    os.utime(file_path, (epoch, epoch))
PY

rm -f "dist/apptheory_cdk-${expected_py_version}-"*.whl
rm -f "dist/apptheory_cdk-${expected_py_version}.tar.gz"
rm -f "dist/apptheory-cdk-${expected_py_version}.tar.gz"

if ! cdk/.venv/bin/python -m build --no-isolation "${tmp_dir}/python" --outdir dist >/dev/null 2>"${tmp_log}"; then
  echo "cdk-python-build: FAIL (python build failed)" >&2
  cat "${tmp_log}" >&2
  exit 1
fi

if ! ls "dist/apptheory_cdk-${expected_py_version}-"*.whl >/dev/null 2>&1; then
  echo "cdk-python-build: FAIL (missing wheel for ${expected_version})"
  exit 1
fi

wheel_path="$(ls "dist/apptheory_cdk-${expected_py_version}-"*.whl | head -n 1)"
WHEEL_PATH="${wheel_path}" python3 - <<'PY'
import zipfile
from pathlib import Path

wheel = Path(__import__("os").environ["WHEEL_PATH"])
with zipfile.ZipFile(wheel) as z:
  names = z.namelist()

def is_license(name: str) -> bool:
  upper = name.upper()
  return upper.endswith("/LICENSE") or upper.endswith("/LICENSE.TXT") or upper.endswith("/LICENSE.MD")

matches = [n for n in names if is_license(n)]
if not matches:
  raise SystemExit(f"cdk-python-build: FAIL (wheel missing LICENSE file: {wheel.name})")
PY

sdist=""
if [[ -f "dist/apptheory_cdk-${expected_py_version}.tar.gz" ]]; then
  sdist="dist/apptheory_cdk-${expected_py_version}.tar.gz"
elif [[ -f "dist/apptheory-cdk-${expected_py_version}.tar.gz" ]]; then
  sdist="dist/apptheory-cdk-${expected_py_version}.tar.gz"
else
  echo "cdk-python-build: FAIL (missing sdist for ${expected_version})"
  exit 1
fi

TMP_SDIST_PATH="${sdist}" python3 - <<'PY'
import gzip
import os
import shutil
import tarfile
from pathlib import Path

epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
sdist = Path(os.environ["TMP_SDIST_PATH"])

extract_dir = Path(os.environ.get("TMPDIR", "/tmp")) / f"apptheory-cdk-sdist-{os.getpid()}"
shutil.rmtree(extract_dir, ignore_errors=True)
extract_dir.mkdir(parents=True, exist_ok=True)

with tarfile.open(sdist, "r:gz") as tf:
  tf.extractall(extract_dir)

roots = [p for p in extract_dir.iterdir() if p.is_dir()]
if len(roots) != 1:
  raise SystemExit(f"expected one top-level folder in sdist, found {len(roots)}")

root = roots[0]

tmp_out = sdist.with_name(sdist.name + ".tmp")

with open(tmp_out, "wb") as file_out:
  with gzip.GzipFile(filename="", mode="wb", fileobj=file_out, mtime=epoch) as gz:
    with tarfile.open(fileobj=gz, mode="w|") as tar:
      root_info = tar.gettarinfo(str(root), arcname=root.name)
      root_info.uid = 0
      root_info.gid = 0
      root_info.uname = ""
      root_info.gname = ""
      root_info.mtime = epoch
      tar.addfile(root_info)

      dirs = sorted([p for p in root.rglob("*") if p.is_dir()])
      files = sorted([p for p in root.rglob("*") if p.is_file()])

      for dir_path in dirs:
        rel = dir_path.relative_to(extract_dir)
        info = tar.gettarinfo(str(dir_path), arcname=str(rel))
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.mtime = epoch
        tar.addfile(info)

      for file_path in files:
        rel = file_path.relative_to(extract_dir)
        info = tar.gettarinfo(str(file_path), arcname=str(rel))
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.mtime = epoch
        with open(file_path, "rb") as file_in:
          tar.addfile(info, file_in)

tmp_out.replace(sdist)
shutil.rmtree(extract_dir, ignore_errors=True)
PY

tar -tzf "${sdist}" | grep -E "^apptheory[_-]cdk-${expected_py_version}/LICENSE$" >/dev/null || {
  echo "cdk-python-build: FAIL (sdist missing LICENSE for ${expected_version})"
  exit 1
}

echo "cdk-python-build: PASS (${expected_version})"
