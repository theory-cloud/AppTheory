import { CfnOutput, Duration, Tags } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ssm from "aws-cdk-lib/aws-ssm";
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

export class AppTheoryHostedZone extends Construct {
  public readonly hostedZone: route53.IHostedZone;
  public readonly hostedZoneId: string;
  public readonly zoneName: string;
  public readonly isImported: boolean;

  constructor(scope: Construct, id: string, props: AppTheoryHostedZoneProps) {
    super(scope, id);

    const zoneName = String(props.zoneName ?? "").trim();
    if (!zoneName) {
      throw new Error("AppTheoryHostedZone requires props.zoneName");
    }

    this.zoneName = zoneName;

    const importIfExists = props.importIfExists ?? false;
    const enableSsmExport = props.enableSsmExport ?? false;
    const enableCfnExport = props.enableCfnExport ?? false;

    if (importIfExists && props.existingZoneId) {
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: props.existingZoneId,
        zoneName,
      });
      this.hostedZoneId = props.existingZoneId;
      this.isImported = true;
    } else {
      const zone = new route53.PublicHostedZone(this, "HostedZone", {
        zoneName,
        comment: props.comment,
      });
      this.hostedZone = zone;
      this.hostedZoneId = zone.hostedZoneId;
      this.isImported = false;

      if (props.tags) {
        for (const [key, value] of Object.entries(props.tags)) {
          Tags.of(zone).add(key, value);
        }
      }
    }

    if (enableSsmExport) {
      const parameterName = props.ssmParameterPath ?? `/route53/zones/${zoneName}/id`;
      new ssm.StringParameter(this, "ZoneIdParameter", {
        parameterName,
        stringValue: this.hostedZoneId,
        description: `Hosted Zone ID for ${zoneName}`,
      });
    }

    if (enableCfnExport) {
      const exportName =
        props.cfnExportName ?? sanitizeCloudFormationExportName(`HostedZoneId-${zoneName}`);

      new CfnOutput(this, "ZoneIdOutput", {
        value: this.hostedZoneId,
        description: `Hosted Zone ID for ${zoneName}`,
        exportName,
      });
    }
  }

  nameServers(): string[] | undefined {
    if (this.isImported) return undefined;
    return this.hostedZone.hostedZoneNameServers;
  }

  addNsRecord(recordName: string, targetNameServers: string[], ttl: Duration): route53.NsRecord {
    return new route53.NsRecord(this, `NSRecord-${sanitizeConstructIdSuffix(recordName)}`, {
      zone: this.hostedZone,
      recordName,
      values: targetNameServers,
      ttl,
    });
  }

  addCnameRecord(recordName: string, domainName: string, ttl: Duration): route53.CnameRecord {
    return new route53.CnameRecord(this, `CNAMERecord-${sanitizeConstructIdSuffix(recordName)}`, {
      zone: this.hostedZone,
      recordName,
      domainName,
      ttl,
    });
  }
}

function sanitizeCloudFormationExportName(name: string): string {
  const input = String(name ?? "").trim();
  if (!input) return "export";

  let out = "";
  let lastWasDash = false;

  for (const r of input) {
    const isAllowed =
      (r >= "a" && r <= "z") ||
      (r >= "A" && r <= "Z") ||
      (r >= "0" && r <= "9") ||
      r === ":" ||
      r === "-";
    if (isAllowed) {
      out += r;
      lastWasDash = r === "-";
      continue;
    }
    if (!lastWasDash) {
      out += "-";
      lastWasDash = true;
    }
  }

  out = out.replace(/^-+/, "").replace(/-+$/, "");
  return out ? out : "export";
}

function sanitizeConstructIdSuffix(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "record";
  const out = raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return out ? out : "record";
}
