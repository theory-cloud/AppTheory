#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CodeBuildJobRunnerStack } from "../lib/codebuild-job-runner-stack";

const app = new cdk.App();
new CodeBuildJobRunnerStack(app, "AppTheoryCodeBuildJobRunnerExample");

