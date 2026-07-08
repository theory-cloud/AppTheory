#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { S3VectorsSemanticSearchStack } from "../lib/semantic-search-stack";

const app = new cdk.App();
const stackName = normalizeStackName(app.node.tryGetContext("stackName") ?? "AppTheoryS3VectorsSemanticSearch");

new S3VectorsSemanticSearchStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  },
});

function normalizeStackName(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(value) || value.length > 128) {
    throw new Error("s3-vectors-semantic-search stackName must start with a letter and contain only letters, numbers, and hyphens");
  }
  return value;
}
