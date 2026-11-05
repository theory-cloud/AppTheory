#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EdgeGatewayStack } from '../lib/stack';

const app = new cdk.App();

new EdgeGatewayStack(app, 'EdgeGatewayExample', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
