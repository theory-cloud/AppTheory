#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { S3VectorsSemanticSearchStack } from "../lib/semantic-search-stack";

const app = new cdk.App();

new S3VectorsSemanticSearchStack(app, "AppTheoryS3VectorsSemanticSearch", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  },
});
