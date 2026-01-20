#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { MultiLangStack } from "../lib/multilang-stack";

const app = new cdk.App();

new MultiLangStack(app, "AppTheoryMultilangDemo");

