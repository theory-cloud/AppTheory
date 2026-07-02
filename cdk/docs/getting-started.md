# Getting Started (CDK)

This guide deploys a minimal HTTP API backed by a Lambda function that runs an AppTheory application.

## Install

AppTheory CDK is distributed via **GitHub Releases** (no npm/PyPI registry publishing). Pin and verify the jsii package assets before installing them:

```bash
VERSION=1.14.0
TAG="v${VERSION}"
REPO="theory-cloud/AppTheory"

gh release download "${TAG}" --repo "${REPO}" \
  --pattern "theory-cloud-apptheory-cdk-${VERSION}.tgz" \
  --pattern "apptheory_cdk-${VERSION}-py3-none-any.whl" \
  --pattern "SHA256SUMS.txt" \
  --clobber
grep -E " (theory-cloud-apptheory-cdk-${VERSION}\.tgz|apptheory_cdk-${VERSION}-py3-none-any\.whl)$" SHA256SUMS.txt | sha256sum -c -
npm install "./theory-cloud-apptheory-cdk-${VERSION}.tgz"
python -m pip install "./apptheory_cdk-${VERSION}-py3-none-any.whl"
```

## Minimal example (TypeScript)

```ts
// CORRECT: Use AppTheoryHttpApi for proxy routing with consistent defaults.
import { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AppTheoryHttpApi } from "@theory-cloud/apptheory-cdk";

const stack = new Stack();
const fn = new lambda.Function(stack, "Handler", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("dist"),
});

new AppTheoryHttpApi(stack, "Api", { handler: fn, apiName: "my-api" });
```

## Next steps

- See `examples/cdk/` for reference stacks.
- Run the repo synth verifier: `./scripts/verify-cdk-synth.sh`.

