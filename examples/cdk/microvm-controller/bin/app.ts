#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { MicrovmControllerStack } from "../lib/microvm-controller-stack";

const app = new cdk.App();

new MicrovmControllerStack(app, "AppTheoryMicrovmControllerDemo");
