#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { LocalIamPeerStack } from "../lib/local-iam-peer-stack";

const app = new cdk.App();

new LocalIamPeerStack(app, "local-iam-peer", {
  env: { account: "123456789012", region: "us-east-1" },
  stackName: "local-iam-peer",
});

app.synth();
