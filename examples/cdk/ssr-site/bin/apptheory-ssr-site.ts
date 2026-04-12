#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { SsrSiteStack } from "../lib/ssr-site-stack";

const app = new cdk.App();

const stackName = String(process.env.APPTHEORY_SSR_SITE_STACK_NAME ?? "").trim() || "AppTheorySsrSiteDemo";

new SsrSiteStack(app, stackName);
