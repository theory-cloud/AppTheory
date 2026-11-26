#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { WebFunctionStack } from "../lib/web-function-stack";

const app = new cdk.App();

new WebFunctionStack(app, "AppTheoryWebFunctionExample");
