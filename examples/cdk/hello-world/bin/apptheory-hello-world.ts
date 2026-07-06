#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";

import { HelloWorldStack, normalizeHelloWorldLanguage } from "../lib/hello-world-stack";

const app = new cdk.App();
const lang = normalizeHelloWorldLanguage(app.node.tryGetContext("lang") ?? "ts");
const stackIdByLang = {
  go: "AppTheoryHelloWorldGo",
  ts: "AppTheoryHelloWorldTs",
  py: "AppTheoryHelloWorldPy",
} as const;

new HelloWorldStack(app, stackIdByLang[lang], { lang });
