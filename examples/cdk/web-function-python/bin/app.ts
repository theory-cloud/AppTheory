#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { WebFunctionPythonStack } from "../lib/web-function-stack";

const app = new cdk.App();

new WebFunctionPythonStack(app, "AppTheoryWebFunctionPythonExample");
