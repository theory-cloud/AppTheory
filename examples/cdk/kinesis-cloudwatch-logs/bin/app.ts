#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { KinesisCloudWatchLogsStack } from "../lib/kinesis-cloudwatch-logs-stack";

const app = new cdk.App();

// Deterministic placeholder environment for synth only. Replace these values
// before any real deployment; they are not live account claims.
new KinesisCloudWatchLogsStack(app, "AppTheoryKinesisCloudWatchLogsDemo", {
  env: {
    account: "111122223333",
    region: "us-east-1",
  },
});
