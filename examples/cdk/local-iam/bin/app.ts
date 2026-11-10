#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { LocalIamStack } from "../lib/local-iam-stack";

const app = new cdk.App();

// The local run resolves every account and region from this environment, so the
// ARNs the policies name and the ARNs the runner compares are the same.
new LocalIamStack(app, "local-iam", {
  env: { account: "123456789012", region: "us-east-1" },
  stackName: "local-iam",
});

app.synth();
