#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { LocalMcpAuthFacadeStack } from "../lib/local-mcp-auth-facade-stack";

const app = new cdk.App();

// The local run serves the app over TLS at a pinned host and port, so the
// public base URL (and therefore every advertised endpoint) is the run's own
// HTTPS origin. The default keeps a plain synth deterministic and is what the
// pinned template records.
const publicBaseUrl = String(app.node.tryGetContext("publicBaseUrl") ?? "").trim();

new LocalMcpAuthFacadeStack(app, "AppTheoryLocalMcpAuthFacade", {
  env: { account: "123456789012", region: "us-east-1" },
  stackName: "local-mcp-auth-facade",
  publicBaseUrl: publicBaseUrl === "" ? undefined : publicBaseUrl,
  handleTTL: app.node.tryGetContext("handleTTL"),
  graceWindow: app.node.tryGetContext("graceWindow"),
  accessTTL: app.node.tryGetContext("accessTTL"),
});

app.synth();
