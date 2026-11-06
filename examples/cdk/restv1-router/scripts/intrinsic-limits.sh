#!/bin/sh
# Show the resolved CloudFormation-expression limits. Run from the repository
# root; the local runner resolves Ref (a parameter Default), Fn::If (a
# condition over defaults) and Fn::FindInMap from the synthesized template.
#   sh examples/cdk/restv1-router/scripts/intrinsic-limits.sh
set -eu
go run ./cmd/apptheory-local plan \
  --app examples/cdk/restv1-router \
  --profile scripts/local/examples-local.json --json |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print([(f["logicalId"], f["memoryMb"], f["timeout"]) for f in d["functions"] if f["handler"] in ("inventory.handler","graphql.handler")])'
