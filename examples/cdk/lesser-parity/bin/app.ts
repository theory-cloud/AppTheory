#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LesserParityStack } from "../lib/lesser-parity-stack";

const app = new cdk.App();

new LesserParityStack(app, "LesserParityExample", {
    description: "AppTheory CDK Lesser Parity example: full Lift CDK replacement validation",
});
