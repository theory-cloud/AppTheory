import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
export interface AppTheoryApiDomainProps {
    readonly domainName: string;
    readonly apiMappingKey?: string;
    readonly certificate: acm.ICertificate;
    readonly httpApi: apigwv2.IHttpApi;
    readonly stage?: apigwv2.IStage;
    readonly hostedZone?: route53.IHostedZone;
    readonly mutualTlsAuthentication?: apigwv2.MTLSConfig;
    readonly recordTtl?: Duration;
    readonly createCname?: boolean;
    readonly securityPolicy?: apigwv2.SecurityPolicy;
}
export declare class AppTheoryApiDomain extends Construct {
    readonly domainName: apigwv2.DomainName;
    readonly apiMapping: apigwv2.ApiMapping;
    readonly cnameRecord?: route53.CnameRecord;
    readonly domainString: string;
    constructor(scope: Construct, id: string, props: AppTheoryApiDomainProps);
}
