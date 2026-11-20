import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type { AppTheoryNamingContext } from "./naming-context";
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
    /**
     * TLS security policy for the custom domain.
     *
     * With a derived naming context the default is TLS 1.2, the strongest policy
     * API Gateway v2 offers. Security Hub APIGateway.11 always fails a custom
     * domain attached to an HTTP API, so no policy can satisfy it.
     *
     * @default TLS 1.2 under a derived naming context, otherwise the API Gateway default
     */
    readonly securityPolicy?: apigwv2.SecurityPolicy;
    /**
     * Optional naming context that selects the Security Hub-aligned defaults.
     *
     * @default undefined
     */
    readonly namingContext?: AppTheoryNamingContext;
}
export declare class AppTheoryApiDomain extends Construct {
    readonly domainName: apigwv2.DomainName;
    readonly apiMapping: apigwv2.ApiMapping;
    readonly cnameRecord?: route53.CnameRecord;
    readonly domainString: string;
    constructor(scope: Construct, id: string, props: AppTheoryApiDomainProps);
}
