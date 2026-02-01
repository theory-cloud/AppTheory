#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PathRoutedFrontendStack } from '../lib/stack';

const app = new cdk.App();

new PathRoutedFrontendStack(app, 'PathRoutedFrontendExample', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
