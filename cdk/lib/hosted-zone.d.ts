import { Duration } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
export interface AppTheoryHostedZoneProps {
    readonly zoneName: string;
    readonly comment?: string;
    readonly importIfExists?: boolean;
    readonly existingZoneId?: string;
    readonly enableSsmExport?: boolean;
    readonly ssmParameterPath?: string;
    readonly enableCfnExport?: boolean;
    readonly cfnExportName?: string;
    readonly tags?: Record<string, string>;
}
export declare class AppTheoryHostedZone extends Construct {
    readonly hostedZone: route53.IHostedZone;
    readonly hostedZoneId: string;
    readonly zoneName: string;
    readonly isImported: boolean;
    constructor(scope: Construct, id: string, props: AppTheoryHostedZoneProps);
    nameServers(): string[] | undefined;
    addNsRecord(recordName: string, targetNameServers: string[], ttl: Duration): route53.NsRecord;
    addCnameRecord(recordName: string, domainName: string, ttl: Duration): route53.CnameRecord;
}
