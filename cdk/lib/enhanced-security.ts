import { CfnTag, Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
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

export class AppTheoryEnhancedSecurity extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly waf?: wafv2.CfnWebACL;
  public readonly secrets: Record<string, secretsmanager.Secret>;
  public readonly vpcFlowLogsGroup?: logs.LogGroup;
  public readonly securityMetrics: Record<string, cloudwatch.IMetric>;
  public readonly vpcEndpoints: Record<string, ec2.InterfaceVpcEndpoint>;

  private readonly applicationName: string;
  private readonly environment: string;

  constructor(scope: Construct, id: string, props: AppTheoryEnhancedSecurityProps) {
    super(scope, id);

    this.secrets = {};
    this.securityMetrics = {};
    this.vpcEndpoints = {};

    const enableWaf = props.enableWaf ?? true;
    const enableVpcFlowLogs = props.enableVpcFlowLogs ?? true;

    this.environment = props.environment ?? "production";
    this.applicationName = props.applicationName ?? "apptheory-app";

    const wafConfig: AppTheoryWafRuleConfig = props.wafConfig ?? {
      enableRateLimit: true,
      rateLimit: 2000,
      enableSQLiProtection: true,
      enableXSSProtection: true,
      enableKnownBadInputs: true,
    };

    const vpcEndpointConfig: AppTheoryVpcEndpointConfig = props.vpcEndpointConfig ?? {
      enableSecretsManager: true,
      enableCloudWatchLogs: true,
      enableXRay: true,
      enableKms: false,
      enableCloudWatchMonitoring: false,
      privateDnsEnabled: true,
    };

    this.securityGroup = this.createSecurityGroup({
      vpc: props.vpc,
      ingressRules: props.ingressRules ?? [],
      egressRules: props.egressRules ?? [],
    });

    if (enableWaf) {
      const builder = new WafBuilder(this, wafConfig, this.applicationName, this.environment);
      this.waf = builder.build();
    }

    this.createSecrets(props.secrets ?? [], this.applicationName, this.environment);
    this.createVpcEndpoints(props.vpc, vpcEndpointConfig);

    if (enableVpcFlowLogs) {
      this.vpcFlowLogsGroup = this.enableVpcFlowLogs(props.vpc, this.applicationName);
    }

    this.configureSecurityMonitoring();
  }

  wafWebAcl(): wafv2.CfnWebACL {
    if (!this.waf) {
      throw new Error("WAF is not enabled");
    }
    return this.waf;
  }

  securityGroupResource(): ec2.ISecurityGroup {
    return this.securityGroup;
  }

  secret(name: string): secretsmanager.Secret {
    const secret = this.secrets[name];
    if (!secret) {
      throw new Error(`unknown secret: ${name}`);
    }
    return secret;
  }

  vpcEndpoint(name: string): ec2.InterfaceVpcEndpoint {
    const endpoint = this.vpcEndpoints[name];
    if (!endpoint) {
      throw new Error(`unknown VPC endpoint: ${name}`);
    }
    return endpoint;
  }

  securityMetric(name: string): cloudwatch.IMetric {
    const metric = this.securityMetrics[name];
    if (!metric) {
      throw new Error(`unknown security metric: ${name}`);
    }
    return metric;
  }

  addCustomSecurityRule(rule: AppTheorySecurityRule, direction: "ingress" | "egress"): void {
    if (direction === "ingress") {
      this.securityGroup.addIngressRule(
        rule.source,
        portForRule(rule.port, rule.protocol),
        rule.description,
        false,
      );
      this.createSecurityRuleMetric("ingress_custom", rule);
      return;
    }

    this.securityGroup.addEgressRule(rule.source, portForRule(rule.port, rule.protocol), rule.description, false);
    this.createSecurityRuleMetric("egress_custom", rule);
  }

  private createSecurityGroup(args: {
    vpc: ec2.IVpc;
    ingressRules: AppTheorySecurityRule[];
    egressRules: AppTheorySecurityRule[];
  }): ec2.SecurityGroup {
    const group = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: args.vpc,
      description: `Security group for ${this.applicationName}`,
      allowAllOutbound: false,
      disableInlineRules: true,
    });

    for (let i = 0; i < args.ingressRules.length; i++) {
      const rule = args.ingressRules[i];
      group.addIngressRule(rule.source, portForRule(rule.port, rule.protocol), rule.description, false);
      this.createSecurityRuleMetric(`IngressRule${i}`, rule);
    }

    for (let i = 0; i < args.egressRules.length; i++) {
      const rule = args.egressRules[i];
      group.addEgressRule(rule.source, portForRule(rule.port, rule.protocol), rule.description, false);
      this.createSecurityRuleMetric(`EgressRule${i}`, rule);
    }

    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Allow HTTPS to AWS services", false);
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), "Allow DNS resolution", false);

    Tags.of(group).add("Environment", this.environment);
    Tags.of(group).add("Application", this.applicationName);
    Tags.of(group).add("SecurityLevel", "Enhanced");

    return group;
  }

  private createSecurityRuleMetric(ruleId: string, rule: AppTheorySecurityRule): void {
    const metricName = `Traffic_${ruleId}`;
    this.securityMetrics[metricName] = new cloudwatch.Metric({
      namespace: "Security/NetworkRules",
      metricName,
      dimensionsMap: {
        RuleId: ruleId,
        Port: String(Math.trunc(rule.port)),
        Protocol: String(rule.protocol),
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });
  }

  private createSecrets(configs: AppTheorySecretConfig[], applicationName: string, environment: string): void {
    for (const config of configs) {
      const secret = new secretsmanager.Secret(this, config.name, {
        description: config.description,
        removalPolicy: RemovalPolicy.RETAIN,
        ...(config.template
          ? {
              generateSecretString: {
                secretStringTemplate: config.template,
                generateStringKey: config.generateKey ?? "password",
                excludeCharacters: config.excludeChars ?? "",
                passwordLength: config.length ?? 32,
                excludePunctuation: true,
                excludeNumbers: false,
                excludeLowercase: false,
                excludeUppercase: false,
                requireEachIncludedType: true,
              } as secretsmanager.SecretStringGenerator,
            }
          : {}),
      });

      if (config.enableRotation) {
        const rotationSchedule: secretsmanager.RotationScheduleOptions = {
          ...(config.rotationSchedule ?? { automaticallyAfter: Duration.days(30) }),
          ...(config.rotationLambda ? { rotationLambda: config.rotationLambda } : {}),
        };
        secret.addRotationSchedule(`${config.name}Rotation`, rotationSchedule);
      }

      Tags.of(secret).add("Environment", environment);
      Tags.of(secret).add("Application", applicationName);
      Tags.of(secret).add("DataClassification", "Confidential");

      this.secrets[config.name] = secret;
    }
  }

  private createVpcEndpoints(vpc: ec2.IVpc, config: AppTheoryVpcEndpointConfig): void {
    const privateDnsEnabled = config.privateDnsEnabled ?? true;

    const mk = (name: string, service: ec2.IInterfaceVpcEndpointService): ec2.InterfaceVpcEndpoint =>
      new ec2.InterfaceVpcEndpoint(this, `${name}Endpoint`, {
        vpc,
        service,
        securityGroups: [this.securityGroup],
        privateDnsEnabled,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });

    if (config.enableSecretsManager) {
      this.vpcEndpoints["SecretsManager"] = mk("SecretsManager", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
    }
    if (config.enableCloudWatchLogs) {
      this.vpcEndpoints["CloudWatchLogs"] = mk("CloudWatchLogs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
    }
    if (config.enableXRay) {
      this.vpcEndpoints["XRay"] = mk("XRay", ec2.InterfaceVpcEndpointAwsService.XRAY);
    }
    if (config.enableKms) {
      this.vpcEndpoints["KMS"] = mk("KMS", ec2.InterfaceVpcEndpointAwsService.KMS);
    }
    if (config.enableCloudWatchMonitoring) {
      this.vpcEndpoints["CloudWatchMonitoring"] = mk(
        "CloudWatchMonitoring",
        ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      );
    }
  }

  private enableVpcFlowLogs(vpc: ec2.IVpc, applicationName: string): logs.LogGroup {
    const logGroup = new logs.LogGroup(this, "VPCFlowLogsGroup", {
      logGroupName: `/aws/vpc/flowlogs/${applicationName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, "VPCFlowLogsRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      inlinePolicies: {
        FlowLogsDeliveryRolePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
              resources: [logGroup.logGroupArn],
            }),
          ],
        }),
      },
    });

    new ec2.FlowLog(this, "VPCFlowLogs", {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup, role),
      trafficType: ec2.FlowLogTrafficType.ALL,
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
    });

    return logGroup;
  }

  private configureSecurityMonitoring(): void {
    this.securityMetrics["WAFBlockedRequests"] = new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        WebACL: `${this.applicationName}WAF`,
        Region: Stack.of(this).region,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    this.securityMetrics["SecurityGroupChanges"] = new cloudwatch.Metric({
      namespace: "AWS/Events",
      metricName: "SecurityGroupChanges",
      dimensionsMap: {
        Application: this.applicationName,
        Environment: this.environment,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    if (this.vpcFlowLogsGroup) {
      new logs.MetricFilter(this, "RejectedConnectionsFilter", {
        logGroup: this.vpcFlowLogsGroup,
        metricNamespace: "Security/VPC",
        metricName: "RejectedConnections",
        filterPattern: logs.FilterPattern.spaceDelimited(
          "version",
          "account",
          "eni",
          "source",
          "destination",
          "srcport",
          "destport",
          "protocol",
          "packets",
          "bytes",
          "windowstart",
          "windowend",
          "action",
          "flowlogstatus",
        ).whereString("action", "=", "REJECT"),
        metricValue: "1",
        defaultValue: 0,
      });

      new logs.MetricFilter(this, "SuspiciousPortsFilter", {
        logGroup: this.vpcFlowLogsGroup,
        metricNamespace: "Security/VPC",
        metricName: "SuspiciousPortActivity",
        filterPattern: logs.FilterPattern.anyTerm("destport=22", "destport=23", "destport=3389"),
        metricValue: "1",
        defaultValue: 0,
      });
    }
  }
}

function portForRule(port: number, protocol: ec2.Protocol): ec2.Port {
  switch (protocol) {
    case ec2.Protocol.TCP:
      return ec2.Port.tcp(port);
    case ec2.Protocol.UDP:
      return ec2.Port.udp(port);
    case ec2.Protocol.ALL:
      return ec2.Port.allTraffic();
    default:
      return ec2.Port.tcp(port);
  }
}

class WafBuilder {
  private readonly rules: wafv2.CfnWebACL.RuleProperty[] = [];
  private priority = 1;

  constructor(
    private readonly scope: Construct,
    private readonly config: AppTheoryWafRuleConfig,
    private readonly applicationName: string,
    private readonly environment: string,
  ) {}

  build(): wafv2.CfnWebACL {
    this.addRateLimitRule();
    this.addManagedRules();
    this.addIpRules();
    this.addGeoBlockingRule();
    return this.createWebAcl();
  }

  private addRateLimitRule(): void {
    if (!this.config.enableRateLimit) return;

    const limit = this.config.rateLimit ?? 2000;
    this.rules.push({
      name: "RateLimitRule",
      priority: this.priority++,
      statement: {
        rateBasedStatement: {
          limit,
          aggregateKeyType: "IP",
        },
      },
      action: {
        block: {
          customResponse: {
            responseCode: 429,
            customResponseBodyKey: "RateLimitExceeded",
          },
        },
      },
      visibilityConfig: visibilityConfig("RateLimitRule"),
    });
  }

  private addManagedRules(): void {
    const managed = [
      { enabled: this.config.enableSQLiProtection, name: "SQLiProtection", ruleSet: "AWSManagedRulesSQLiRuleSet" },
      { enabled: this.config.enableXSSProtection, name: "XSSProtection", ruleSet: "AWSManagedRulesCommonRuleSet" },
      { enabled: this.config.enableKnownBadInputs, name: "KnownBadInputs", ruleSet: "AWSManagedRulesKnownBadInputsRuleSet" },
    ];

    for (const rule of managed) {
      if (!rule.enabled) continue;
      this.rules.push(managedWafRule(rule.name, rule.ruleSet, this.priority++));
    }
  }

  private addIpRules(): void {
    if (this.config.ipWhitelist && this.config.ipWhitelist.length > 0) {
      this.rules.push(this.createIpRule("IPWhitelist", "Whitelist", this.config.ipWhitelist, true));
      this.priority++;
    }
    if (this.config.ipBlacklist && this.config.ipBlacklist.length > 0) {
      this.rules.push(this.createIpRule("IPBlacklist", "Blacklist", this.config.ipBlacklist, false));
      this.priority++;
    }
  }

  private createIpRule(name: string, ipSetName: string, ips: string[], allow: boolean): wafv2.CfnWebACL.RuleProperty {
    return {
      name,
      priority: this.priority,
      statement: {
        ipSetReferenceStatement: {
          arn: this.createIpSet(ipSetName, ips),
        },
      },
      ...(allow
        ? { action: { allow: {} } }
        : { action: { block: {} } }),
      visibilityConfig: visibilityConfig(name),
    };
  }

  private addGeoBlockingRule(): void {
    if (!this.config.geoBlocking || this.config.geoBlocking.length === 0) return;

    this.rules.push({
      name: "GeoBlocking",
      priority: this.priority++,
      statement: {
        geoMatchStatement: {
          countryCodes: this.config.geoBlocking,
        },
      },
      action: { block: {} },
      visibilityConfig: visibilityConfig("GeoBlocking"),
    });
  }

  private createWebAcl(): wafv2.CfnWebACL {
    return new wafv2.CfnWebACL(this.scope, "WebACL", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      rules: this.rules,
      customResponseBodies: {
        RateLimitExceeded: {
          contentType: "APPLICATION_JSON",
          content: `{"error": "rate_limit_exceeded", "message": "Too many requests", "retry_after": 60}`,
        },
        AccessDenied: {
          contentType: "APPLICATION_JSON",
          content: `{"error": "access_denied", "message": "Access denied by security policy"}`,
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${this.applicationName}WAF`,
      },
      tags: [
        { key: "Environment", value: this.environment },
        { key: "Application", value: this.applicationName },
      ] as CfnTag[],
    });
  }

  private createIpSet(name: string, ips: string[]): string {
    const ipSet = new wafv2.CfnIPSet(this.scope, `IPSet${name}`, {
      scope: "REGIONAL",
      ipAddressVersion: "IPV4",
      addresses: ips,
      tags: [{ key: "Name", value: name }] as CfnTag[],
    });
    return ipSet.attrArn;
  }
}

function visibilityConfig(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName,
  };
}

function managedWafRule(name: string, ruleSet: string, priority: number): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name: ruleSet,
      },
    },
    overrideAction: { none: {} },
    visibilityConfig: visibilityConfig(name),
  };
}
