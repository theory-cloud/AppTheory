#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { LambdaPackagingStack } from "../lib/lambda-packaging-stack";

const app = new cdk.App();
new LambdaPackagingStack(app, "AppTheoryLambdaPackagingExample");
