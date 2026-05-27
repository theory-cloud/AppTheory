#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { SsrOnlyProvidedAssetsSiteStack } from "../lib/ssr-only-provided-assets-site-stack";

const app = new cdk.App();
const stackName =
  String(process.env.APPTHEORY_SSR_ONLY_PROVIDED_ASSETS_STACK_NAME ?? "").trim() ||
  "AppTheorySsrOnlyProvidedAssetsSiteDemo";

new SsrOnlyProvidedAssetsSiteStack(app, stackName);
