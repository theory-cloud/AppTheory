#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SqsQueueStack } from "../lib/sqs-stack";

const app = new cdk.App();
new SqsQueueStack(app, "SqsQueueExample");
