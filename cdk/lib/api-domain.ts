import { CfnOutput, Duration } from "aws-cdk-lib";
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

export class AppTheoryApiDomain extends Construct {
  public readonly domainName: apigwv2.DomainName;
  public readonly apiMapping: apigwv2.ApiMapping;
  public readonly cnameRecord?: route53.CnameRecord;
  public readonly domainString: string;

  constructor(scope: Construct, id: string, props: AppTheoryApiDomainProps) {
    super(scope, id);

    const domainName = String(props.domainName ?? "").trim();
    if (!domainName) {
      throw new Error("AppTheoryApiDomain requires props.domainName");
    }

    this.domainString = domainName;

    const createCname = props.createCname ?? Boolean(props.hostedZone);
    const recordTtl = props.recordTtl ?? Duration.seconds(300);

    const domainProps: apigwv2.DomainNameProps = {
      domainName,
      certificate: props.certificate,
      mtls: props.mutualTlsAuthentication,
      securityPolicy: props.securityPolicy,
    };

    this.domainName = new apigwv2.DomainName(this, "CustomDomain", domainProps);

    const stage = props.stage ?? props.httpApi.defaultStage;
    if (!stage) {
      throw new Error("AppTheoryApiDomain requires props.stage when httpApi has no defaultStage");
    }

    this.apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
      api: props.httpApi,
      domainName: this.domainName,
      stage,
      apiMappingKey: props.apiMappingKey,
    });

    if (createCname && props.hostedZone) {
      const recordName = toRoute53RecordName(domainName, props.hostedZone);
      this.cnameRecord = new route53.CnameRecord(this, "CNAMERecord", {
        zone: props.hostedZone,
        recordName,
        domainName: this.domainName.regionalDomainName,
        ttl: recordTtl,
      });
    }

    new CfnOutput(this, "CustomDomainName", {
      value: domainName,
      description: "API Custom Domain Name",
    });

    new CfnOutput(this, "RegionalDomainName", {
      value: this.domainName.regionalDomainName,
      description: "API Gateway Regional Domain Name",
    });
  }
}

function toRoute53RecordName(domainName: string, zone: route53.IHostedZone): string {
  const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
  const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
  if (!zoneName) return fqdn;
  if (fqdn === zoneName) return "";
  const suffix = `.${zoneName}`;
  if (fqdn.endsWith(suffix)) {
    return fqdn.slice(0, -suffix.length);
  }
  return fqdn;
}
