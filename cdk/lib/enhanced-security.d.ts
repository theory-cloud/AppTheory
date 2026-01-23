import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
export interface AppTheorySecurityRule {
    readonly source: ec2.IPeer;
    readonly protocol: ec2.Protocol;
    readonly description: string;
    readonly port: number;
}
export interface AppTheorySecretConfig {
    readonly rotationLambda?: lambda.IFunction;
    readonly rotationSchedule?: secretsmanager.RotationScheduleOptions;
    readonly name: string;
    readonly description: string;
    readonly template?: string;
    readonly generateKey?: string;
    readonly excludeChars?: string;
    readonly length?: number;
    readonly enableRotation?: boolean;
}
export interface AppTheoryWafRuleConfig {
    readonly enableRateLimit?: boolean;
    readonly rateLimit?: number;
    readonly enableSQLiProtection?: boolean;
    readonly enableXSSProtection?: boolean;
    readonly enableKnownBadInputs?: boolean;
    readonly ipWhitelist?: string[];
    readonly ipBlacklist?: string[];
    readonly geoBlocking?: string[];
}
export interface AppTheoryVpcEndpointConfig {
    readonly enableSecretsManager?: boolean;
    readonly enableCloudWatchLogs?: boolean;
    readonly enableXRay?: boolean;
    readonly enableKms?: boolean;
    readonly enableCloudWatchMonitoring?: boolean;
    readonly privateDnsEnabled?: boolean;
}
export interface AppTheoryEnhancedSecurityProps {
    readonly vpc: ec2.IVpc;
    readonly enableWaf?: boolean;
    readonly wafConfig?: AppTheoryWafRuleConfig;
    readonly enableVpcFlowLogs?: boolean;
    readonly environment?: string;
    readonly applicationName?: string;
    readonly ingressRules?: AppTheorySecurityRule[];
    readonly egressRules?: AppTheorySecurityRule[];
    readonly secrets?: AppTheorySecretConfig[];
    readonly vpcEndpointConfig?: AppTheoryVpcEndpointConfig;
}
export declare class AppTheoryEnhancedSecurity extends Construct {
    readonly securityGroup: ec2.SecurityGroup;
    readonly waf?: wafv2.CfnWebACL;
    readonly secrets: Record<string, secretsmanager.Secret>;
    readonly vpcFlowLogsGroup?: logs.LogGroup;
    readonly securityMetrics: Record<string, cloudwatch.IMetric>;
    readonly vpcEndpoints: Record<string, ec2.InterfaceVpcEndpoint>;
    private readonly applicationName;
    private readonly environment;
    constructor(scope: Construct, id: string, props: AppTheoryEnhancedSecurityProps);
    wafWebAcl(): wafv2.CfnWebACL;
    securityGroupResource(): ec2.ISecurityGroup;
    secret(name: string): secretsmanager.Secret;
    vpcEndpoint(name: string): ec2.InterfaceVpcEndpoint;
    securityMetric(name: string): cloudwatch.IMetric;
    addCustomSecurityRule(rule: AppTheorySecurityRule, direction: "ingress" | "egress"): void;
    private createSecurityGroup;
    private createSecurityRuleMetric;
    private createSecrets;
    private createVpcEndpoints;
    private enableVpcFlowLogs;
    private configureSecurityMonitoring;
}
