# Third-party dependencies

This directory contains **vendored third‑party tarballs** used to keep deterministic security gates green when an
upstream release is not yet available.

## `aws-cdk-lib`

`aws-cdk-lib-2.244.0+minimatch-10.2.4.tgz` is based on the upstream `aws-cdk-lib@2.244.0` npm tarball, with the
bundled `minimatch` dependency updated to `10.2.4` to address OSV findings (SEC-2).

Regeneration (example):

1) `npm pack aws-cdk-lib@2.244.0`
2) `npm pack minimatch@10.2.4`
3) Replace `package/node_modules/minimatch` in the `aws-cdk-lib` tarball with the contents of the `minimatch` tarball.
4) Repack as `aws-cdk-lib-2.244.0+minimatch-10.2.4.tgz`
