#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { SsrSiteStack } from "../lib/ssr-site-stack";

const app = new cdk.App();

new SsrSiteStack(app, "AppTheorySsrSiteDemo");

