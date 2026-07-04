import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import type { AppTheoryRegionalWafOptions } from "../regional-waf";
export interface AppTheoryRestApiWafResources {
    readonly webAcl?: wafv2.CfnWebACL;
    readonly wafAssociation: wafv2.CfnWebACLAssociation;
}
export declare function configureRestApiRegionalWaf(scope: Construct, api: apigw.RestApi, stage: apigw.IStage, input: boolean | AppTheoryRegionalWafOptions, defaultMetricName: string): AppTheoryRestApiWafResources;
