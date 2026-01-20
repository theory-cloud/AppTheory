import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct, type IConstruct } from "constructs";
export interface AppTheoryCertificateProps {
    readonly domainName: string;
    readonly subjectAlternativeNames?: string[];
    readonly hostedZone: route53.IHostedZone;
    readonly validationZone?: route53.IHostedZone;
    readonly transparencyLoggingEnabled?: boolean;
    readonly certificateName?: string;
}
export declare class AppTheoryCertificate extends Construct {
    readonly certificate: acm.Certificate;
    constructor(scope: Construct, id: string, props: AppTheoryCertificateProps);
    addDependency(dependency: IConstruct): void;
}
