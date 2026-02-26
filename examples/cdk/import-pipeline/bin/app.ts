#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ImportPipelineStack } from "../lib/import-pipeline-stack";

const app = new cdk.App();
new ImportPipelineStack(app, "AppTheoryImportPipelineDemo");

