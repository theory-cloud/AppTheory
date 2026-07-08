#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { MicrovmControllerStack } from "../lib/microvm-controller-stack";

const app = new cdk.App();
const stackName = String(app.node.tryGetContext("stackName") ?? "AppTheoryMicrovmControllerDemo").trim();

new MicrovmControllerStack(app, stackName || "AppTheoryMicrovmControllerDemo");
