#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { LocalTlsStack } from "../lib/local-tls-stack";

const app = new cdk.App();

new LocalTlsStack(app, "AppTheoryLocalTls");
