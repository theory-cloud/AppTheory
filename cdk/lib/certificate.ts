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

export class AppTheoryCertificate extends Construct {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: AppTheoryCertificateProps) {
    super(scope, id);

    const domainName = String(props.domainName ?? "").trim();
    if (!domainName) {
      throw new Error("AppTheoryCertificate requires props.domainName");
    }

    const validationZone = props.validationZone ?? props.hostedZone;

    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames: props.subjectAlternativeNames,
      validation: acm.CertificateValidation.fromDns(validationZone),
      transparencyLoggingEnabled: props.transparencyLoggingEnabled ?? true,
      certificateName: props.certificateName,
    });
  }

  addDependency(dependency: IConstruct): void {
    this.certificate.node.addDependency(dependency);
  }
}

