#!/usr/bin/env python3
"""Keep a regenerated jsii tarball's compressed bytes host-independent.

jsii-pacmak packs the CDK package with npm, which gzips the same tar with the
host's zlib. Linux and macOS produce different deflate streams for identical
content, so a byte comparison of the tarball reports drift that is not there.
The tar itself is already reproducible (npm pins entry mtimes and ownership).

This helper compares the tarballs' *decompressed* content. When a regenerated
tarball has the same content as the checked-in one, the checked-in bytes are
restored, so `git status` reports real binding drift only. A tarball whose
content changed is left exactly as generated, so the drift check still fails.

Usage:
  canonicalize-jsii-tarballs.py <generated-dir> <reference-dir>
  canonicalize-jsii-tarballs.py --self-test
"""

from __future__ import annotations

import gzip
import io
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path


def content(path: Path) -> bytes | None:
    """The tarball's decompressed bytes, or None when it is not a gzip stream."""
    try:
        with gzip.open(path, "rb") as stream:
            return stream.read()
    except (OSError, EOFError):
        return None


def canonicalize(generated_dir: Path, reference_dir: Path) -> int:
    if not generated_dir.is_dir():
        print(f"canonicalize-jsii-tarballs: no generated directory {generated_dir}", file=sys.stderr)
        return 2
    restored = 0
    for generated in sorted(generated_dir.glob("*.tgz")):
        reference = reference_dir / generated.name
        if not reference.is_file():
            print(f"canonicalize-jsii-tarballs: new tarball {generated.name}")
            continue
        generated_content = content(generated)
        reference_content = content(reference)
        if generated_content is None or reference_content is None:
            print(f"canonicalize-jsii-tarballs: {generated.name} is not a gzip stream; left as generated")
            continue
        if generated_content != reference_content:
            print(f"canonicalize-jsii-tarballs: content changed in {generated.name}; left as generated")
            continue
        shutil.copyfile(reference, generated)
        restored += 1
        print(f"canonicalize-jsii-tarballs: {generated.name} content unchanged; kept the checked-in bytes")
    print(f"canonicalize-jsii-tarballs: {restored} tarball(s) canonicalized")
    return 0


def pack(entries: dict[str, bytes], compresslevel: int) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for name, payload in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mtime = 499162500
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))
    tar_bytes = buffer.getvalue()
    output = io.BytesIO()
    # A fixed mtime and OS byte make the gzip header identical on every host;
    # the deflate stream still differs between zlib builds, which is the
    # difference this self-test exercises.
    with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=compresslevel, mtime=0) as stream:
        stream.write(tar_bytes)
    return output.getvalue()


def self_test() -> int:
    entries = {"package/a.txt": b"alpha\n", "package/b.txt": b"beta\n"}
    reference_bytes = pack(entries, 9)
    same_content_bytes = pack(entries, 6)
    changed_entries = dict(entries)
    changed_entries["package/a.txt"] = b"alpha changed\n"
    changed_bytes = pack(changed_entries, 9)
    if reference_bytes == same_content_bytes:
        print("canonicalize-jsii-tarballs self-test: FAIL (the fixture did not vary the deflate stream)", file=sys.stderr)
        return 1
    if reference_bytes == changed_bytes:
        print("canonicalize-jsii-tarballs self-test: FAIL (the fixture did not change the content)", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="canonicalize-jsii-") as scratch:
        generated = Path(scratch) / "generated"
        reference = Path(scratch) / "reference"
        generated.mkdir()
        reference.mkdir()
        (reference / "cdk.tgz").write_bytes(reference_bytes)
        (generated / "cdk.tgz").write_bytes(same_content_bytes)
        (generated / "changed.tgz").write_bytes(changed_bytes)
        if canonicalize(generated, reference) != 0:
            return 1
        if (generated / "cdk.tgz").read_bytes() != reference_bytes:
            print("canonicalize-jsii-tarballs self-test: FAIL (identical content was not canonicalized)", file=sys.stderr)
            return 1
        if (generated / "changed.tgz").read_bytes() != changed_bytes:
            print("canonicalize-jsii-tarballs self-test: FAIL (changed content was overwritten)", file=sys.stderr)
            return 1
    print("canonicalize-jsii-tarballs self-test: PASS (identical content canonicalized, changed content left for drift)")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) != 3:
        print("usage: canonicalize-jsii-tarballs.py <generated-dir> <reference-dir> | --self-test", file=sys.stderr)
        return 2
    return canonicalize(Path(argv[1]), Path(argv[2]))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
