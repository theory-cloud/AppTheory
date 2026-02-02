#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LambdaRoleStack } from "../lib/lambda-role-stack";

const app = new cdk.App();
new LambdaRoleStack(app, "LambdaRoleExample");
