#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { LocalResourcesStack } from "../lib/local-resources-stack";

const app = new cdk.App();

new LocalResourcesStack(app, "local-resources", {
  env: { account: "123456789012", region: "us-east-1" },
  stackName: "local-resources",
});

app.synth();
