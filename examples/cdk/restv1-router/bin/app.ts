#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { RestV1RouterStack } from "../lib/restv1-stack";

const app = new cdk.App();

new RestV1RouterStack(app, "RestV1RouterExample", {
    description: "AppTheoryRestApiRouter example demonstrating multi-Lambda routing with SSE streaming",
});
