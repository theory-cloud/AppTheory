"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryEnhancedSecurity = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const secretsmanager = __importStar(require("aws-cdk-lib/aws-secretsmanager"));
const wafv2 = __importStar(require("aws-cdk-lib/aws-wafv2"));
const constructs_1 = require("constructs");
class AppTheoryEnhancedSecurity extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity", version: "4.3.0" };
    securityGroup;
    waf;
    secrets;
    vpcFlowLogsGroup;
    securityMetrics;
    vpcEndpoints;
    applicationName;
    environment;
    constructor(scope, id, props) {
        super(scope, id);
        this.secrets = {};
        this.securityMetrics = {};
        this.vpcEndpoints = {};
        const enableWaf = props.enableWaf ?? true;
        const enableVpcFlowLogs = props.enableVpcFlowLogs ?? true;
        this.environment = props.environment ?? "production";
        this.applicationName = props.applicationName ?? "apptheory-app";
        const wafConfig = props.wafConfig ?? {
            enableRateLimit: true,
            rateLimit: 2000,
            enableSQLiProtection: true,
            enableXSSProtection: true,
            enableKnownBadInputs: true,
        };
        const vpcEndpointConfig = props.vpcEndpointConfig ?? {
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
    wafWebAcl() {
        if (!this.waf) {
            throw new Error("WAF is not enabled");
        }
        return this.waf;
    }
    securityGroupResource() {
        return this.securityGroup;
    }
    secret(name) {
        const secret = this.secrets[name];
        if (!secret) {
            throw new Error(`unknown secret: ${name}`);
        }
        return secret;
    }
    vpcEndpoint(name) {
        const endpoint = this.vpcEndpoints[name];
        if (!endpoint) {
            throw new Error(`unknown VPC endpoint: ${name}`);
        }
        return endpoint;
    }
    securityMetric(name) {
        const metric = this.securityMetrics[name];
        if (!metric) {
            throw new Error(`unknown security metric: ${name}`);
        }
        return metric;
    }
    addCustomSecurityRule(rule, direction) {
        if (direction === "ingress") {
            this.securityGroup.addIngressRule(rule.source, portForRule(rule.port, rule.protocol), rule.description, false);
            this.createSecurityRuleMetric("ingress_custom", rule);
            return;
        }
        this.securityGroup.addEgressRule(rule.source, portForRule(rule.port, rule.protocol), rule.description, false);
        this.createSecurityRuleMetric("egress_custom", rule);
    }
    createSecurityGroup(args) {
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
        aws_cdk_lib_1.Tags.of(group).add("Environment", this.environment);
        aws_cdk_lib_1.Tags.of(group).add("Application", this.applicationName);
        aws_cdk_lib_1.Tags.of(group).add("SecurityLevel", "Enhanced");
        return group;
    }
    createSecurityRuleMetric(ruleId, rule) {
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
            period: aws_cdk_lib_1.Duration.minutes(5),
        });
    }
    createSecrets(configs, applicationName, environment) {
        for (const config of configs) {
            const secret = new secretsmanager.Secret(this, config.name, {
                description: config.description,
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
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
                        },
                    }
                    : {}),
            });
            if (config.enableRotation) {
                const rotationSchedule = {
                    ...(config.rotationSchedule ?? { automaticallyAfter: aws_cdk_lib_1.Duration.days(30) }),
                    ...(config.rotationLambda ? { rotationLambda: config.rotationLambda } : {}),
                };
                secret.addRotationSchedule(`${config.name}Rotation`, rotationSchedule);
            }
            aws_cdk_lib_1.Tags.of(secret).add("Environment", environment);
            aws_cdk_lib_1.Tags.of(secret).add("Application", applicationName);
            aws_cdk_lib_1.Tags.of(secret).add("DataClassification", "Confidential");
            this.secrets[config.name] = secret;
        }
    }
    createVpcEndpoints(vpc, config) {
        const privateDnsEnabled = config.privateDnsEnabled ?? true;
        const mk = (name, service) => new ec2.InterfaceVpcEndpoint(this, `${name}Endpoint`, {
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
            this.vpcEndpoints["CloudWatchMonitoring"] = mk("CloudWatchMonitoring", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING);
        }
    }
    enableVpcFlowLogs(vpc, applicationName) {
        const logGroup = new logs.LogGroup(this, "VPCFlowLogsGroup", {
            logGroupName: `/aws/vpc/flowlogs/${applicationName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
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
    configureSecurityMonitoring() {
        this.securityMetrics["WAFBlockedRequests"] = new cloudwatch.Metric({
            namespace: "AWS/WAFV2",
            metricName: "BlockedRequests",
            dimensionsMap: {
                WebACL: `${this.applicationName}WAF`,
                Region: aws_cdk_lib_1.Stack.of(this).region,
            },
            statistic: "Sum",
            period: aws_cdk_lib_1.Duration.minutes(5),
        });
        this.securityMetrics["SecurityGroupChanges"] = new cloudwatch.Metric({
            namespace: "AWS/Events",
            metricName: "SecurityGroupChanges",
            dimensionsMap: {
                Application: this.applicationName,
                Environment: this.environment,
            },
            statistic: "Sum",
            period: aws_cdk_lib_1.Duration.minutes(5),
        });
        if (this.vpcFlowLogsGroup) {
            new logs.MetricFilter(this, "RejectedConnectionsFilter", {
                logGroup: this.vpcFlowLogsGroup,
                metricNamespace: "Security/VPC",
                metricName: "RejectedConnections",
                filterPattern: logs.FilterPattern.spaceDelimited("version", "account", "eni", "source", "destination", "srcport", "destport", "protocol", "packets", "bytes", "windowstart", "windowend", "action", "flowlogstatus").whereString("action", "=", "REJECT"),
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
exports.AppTheoryEnhancedSecurity = AppTheoryEnhancedSecurity;
function portForRule(port, protocol) {
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
    scope;
    config;
    applicationName;
    environment;
    rules = [];
    priority = 1;
    constructor(scope, config, applicationName, environment) {
        this.scope = scope;
        this.config = config;
        this.applicationName = applicationName;
        this.environment = environment;
    }
    build() {
        this.addRateLimitRule();
        this.addManagedRules();
        this.addIpRules();
        this.addGeoBlockingRule();
        return this.createWebAcl();
    }
    addRateLimitRule() {
        if (!this.config.enableRateLimit)
            return;
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
    addManagedRules() {
        const managed = [
            { enabled: this.config.enableSQLiProtection, name: "SQLiProtection", ruleSet: "AWSManagedRulesSQLiRuleSet" },
            { enabled: this.config.enableXSSProtection, name: "XSSProtection", ruleSet: "AWSManagedRulesCommonRuleSet" },
            { enabled: this.config.enableKnownBadInputs, name: "KnownBadInputs", ruleSet: "AWSManagedRulesKnownBadInputsRuleSet" },
        ];
        for (const rule of managed) {
            if (!rule.enabled)
                continue;
            this.rules.push(managedWafRule(rule.name, rule.ruleSet, this.priority++));
        }
    }
    addIpRules() {
        if (this.config.ipWhitelist && this.config.ipWhitelist.length > 0) {
            this.rules.push(this.createIpRule("IPWhitelist", "Whitelist", this.config.ipWhitelist, true));
            this.priority++;
        }
        if (this.config.ipBlacklist && this.config.ipBlacklist.length > 0) {
            this.rules.push(this.createIpRule("IPBlacklist", "Blacklist", this.config.ipBlacklist, false));
            this.priority++;
        }
    }
    createIpRule(name, ipSetName, ips, allow) {
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
    addGeoBlockingRule() {
        if (!this.config.geoBlocking || this.config.geoBlocking.length === 0)
            return;
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
    createWebAcl() {
        const defaultAction = this.config.ipWhitelist && this.config.ipWhitelist.length > 0
            ? {
                block: {
                    customResponse: {
                        responseCode: 403,
                        customResponseBodyKey: "AccessDenied",
                    },
                },
            }
            : { allow: {} };
        return new wafv2.CfnWebACL(this.scope, "WebACL", {
            scope: "REGIONAL",
            defaultAction,
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
            ],
        });
    }
    createIpSet(name, ips) {
        const ipSet = new wafv2.CfnIPSet(this.scope, `IPSet${name}`, {
            scope: "REGIONAL",
            ipAddressVersion: "IPV4",
            addresses: ips,
            tags: [{ key: "Name", value: name }],
        });
        return ipSet.attrArn;
    }
}
function visibilityConfig(metricName) {
    return {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName,
    };
}
function managedWafRule(name, ruleSet, priority) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5oYW5jZWQtc2VjdXJpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlbmhhbmNlZC1zZWN1cml0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTJFO0FBQzNFLHVFQUF5RDtBQUN6RCx5REFBMkM7QUFDM0MseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywrRUFBaUU7QUFDakUsNkRBQStDO0FBQy9DLDJDQUF1QztBQXNEdkMsTUFBYSx5QkFBMEIsU0FBUSxzQkFBUzs7SUFDdEMsYUFBYSxDQUFvQjtJQUNqQyxHQUFHLENBQW1CO0lBQ3RCLE9BQU8sQ0FBd0M7SUFDL0MsZ0JBQWdCLENBQWlCO0lBQ2pDLGVBQWUsQ0FBcUM7SUFDcEQsWUFBWSxDQUEyQztJQUV0RCxlQUFlLENBQVM7SUFDeEIsV0FBVyxDQUFTO0lBRXJDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBcUM7UUFDN0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNsQixJQUFJLENBQUMsZUFBZSxHQUFHLEVBQUUsQ0FBQztRQUMxQixJQUFJLENBQUMsWUFBWSxHQUFHLEVBQUUsQ0FBQztRQUV2QixNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUyxJQUFJLElBQUksQ0FBQztRQUMxQyxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxJQUFJLENBQUM7UUFFMUQsSUFBSSxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLFlBQVksQ0FBQztRQUNyRCxJQUFJLENBQUMsZUFBZSxHQUFHLEtBQUssQ0FBQyxlQUFlLElBQUksZUFBZSxDQUFDO1FBRWhFLE1BQU0sU0FBUyxHQUEyQixLQUFLLENBQUMsU0FBUyxJQUFJO1lBQzNELGVBQWUsRUFBRSxJQUFJO1lBQ3JCLFNB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Q0osUUFBUTtRQUNSLFNBQVMsRUFBRTtZQUNULHlCQUF5QixFQUFFO2dCQUN6QixVQUFVLEVBQUUsS0FBSztnQkFDakIsSUFBSSxFQUFFLE9BQU87YUFDZDtTQUNGO1FBQ0QsY0FBYyxFQUFFLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRTtRQUM1QixnQkFBZ0IsRUFBRSxnQkFBZ0IsQ0FBQyxJQUFJLENBQUM7S0FDekMsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBDZm5UYWcsIER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBTdGFjaywgVGFncyB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgY2xvdWR3YXRjaCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2hcIjtcbmltcG9ydCAqIGFzIGVjMiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc2VjcmV0c21hbmFnZXJcIjtcbmltcG9ydCAqIGFzIHdhZnYyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtd2FmdjJcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5U2VjdXJpdHlSdWxlIHtcbiAgcmVhZG9ubHkgc291cmNlOiBlYzIuSVBlZXI7XG4gIHJlYWRvbmx5IHByb3RvY29sOiBlYzIuUHJvdG9jb2w7XG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHBvcnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTZWNyZXRDb25maWcge1xuICByZWFkb25seSByb3RhdGlvbkxhbWJkYT86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IHJvdGF0aW9uU2NoZWR1bGU/OiBzZWNyZXRzbWFuYWdlci5Sb3RhdGlvblNjaGVkdWxlT3B0aW9ucztcbiAgcmVhZG9ubHkgbmFtZTogc3RyaW5nO1xuICByZWFkb25seSBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICByZWFkb25seSB0ZW1wbGF0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGVLZXk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGV4Y2x1ZGVDaGFycz86IHN0cmluZztcbiAgcmVhZG9ubHkgbGVuZ3RoPzogbnVtYmVyO1xuICByZWFkb25seSBlbmFibGVSb3RhdGlvbj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5V2FmUnVsZUNvbmZpZyB7XG4gIHJlYWRvbmx5IGVuYWJsZVJhdGVMaW1pdD86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHJhdGVMaW1pdD86IG51bWJlcjtcbiAgcmVhZG9ubHkgZW5hYmxlU1FMaVByb3RlY3Rpb24/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVYU1NQcm90ZWN0aW9uPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5hYmxlS25vd25CYWRJbnB1dHM/OiBib29sZWFuO1xuICByZWFkb25seSBpcFdoaXRlbGlzdD86IHN0cmluZ1tdO1xuICByZWFkb25seSBpcEJsYWNrbGlzdD86IHN0cmluZ1tdO1xuICByZWFkb25seSBnZW9CbG9ja2luZz86IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVZwY0VuZHBvaW50Q29uZmlnIHtcbiAgcmVhZG9ubHkgZW5hYmxlU2VjcmV0c01hbmFnZXI/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVDbG91ZFdhdGNoTG9ncz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZVhSYXk/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVLbXM/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVDbG91ZFdhdGNoTW9uaXRvcmluZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHByaXZhdGVEbnNFbmFibGVkPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlFbmhhbmNlZFNlY3VyaXR5UHJvcHMge1xuICByZWFkb25seSB2cGM6IGVjMi5JVnBjO1xuICByZWFkb25seSBlbmFibGVXYWY/OiBib29sZWFuO1xuICByZWFkb25seSB3YWZDb25maWc/OiBBcHBUaGVvcnlXYWZSdWxlQ29uZmlnO1xuICByZWFkb25seSBlbmFibGVWcGNGbG93TG9ncz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVudmlyb25tZW50Pzogc3RyaW5nO1xuICByZWFkb25seSBhcHBsaWNhdGlvbk5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGluZ3Jlc3NSdWxlcz86IEFwcFRoZW9yeVNlY3VyaXR5UnVsZVtdO1xuICByZWFkb25seSBlZ3Jlc3NSdWxlcz86IEFwcFRoZW9yeVNlY3VyaXR5UnVsZVtdO1xuICByZWFkb25seSBzZWNyZXRzPzogQXBwVGhlb3J5U2VjcmV0Q29uZmlnW107XG4gIHJlYWRvbmx5IHZwY0VuZHBvaW50Q29uZmlnPzogQXBwVGhlb3J5VnBjRW5kcG9pbnRDb25maWc7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlFbmhhbmNlZFNlY3VyaXR5IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHNlY3VyaXR5R3JvdXA6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgd2FmPzogd2FmdjIuQ2ZuV2ViQUNMO1xuICBwdWJsaWMgcmVhZG9ubHkgc2VjcmV0czogUmVjb3JkPHN0cmluZywgc2VjcmV0c21hbmFnZXIuU2VjcmV0PjtcbiAgcHVibGljIHJlYWRvbmx5IHZwY0Zsb3dMb2dzR3JvdXA/OiBsb2dzLkxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgc2VjdXJpdHlNZXRyaWNzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZHdhdGNoLklNZXRyaWM+O1xuICBwdWJsaWMgcmVhZG9ubHkgdnBjRW5kcG9pbnRzOiBSZWNvcmQ8c3RyaW5nLCBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQ+O1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgYXBwbGljYXRpb25OYW1lOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgZW52aXJvbm1lbnQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RW5oYW5jZWRTZWN1cml0eVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIHRoaXMuc2VjcmV0cyA9IHt9O1xuICAgIHRoaXMuc2VjdXJpdHlNZXRyaWNzID0ge307XG4gICAgdGhpcy52cGNFbmRwb2ludHMgPSB7fTtcblxuICAgIGNvbnN0IGVuYWJsZVdhZiA9IHByb3BzLmVuYWJsZVdhZiA/PyB0cnVlO1xuICAgIGNvbnN0IGVuYWJsZVZwY0Zsb3dMb2dzID0gcHJvcHMuZW5hYmxlVnBjRmxvd0xvZ3MgPz8gdHJ1ZTtcblxuICAgIHRoaXMuZW52aXJvbm1lbnQgPSBwcm9wcy5lbnZpcm9ubWVudCA/PyBcInByb2R1Y3Rpb25cIjtcbiAgICB0aGlzLmFwcGxpY2F0aW9uTmFtZSA9IHByb3BzLmFwcGxpY2F0aW9uTmFtZSA/PyBcImFwcHRoZW9yeS1hcHBcIjtcblxuICAgIGNvbnN0IHdhZkNvbmZpZzogQXBwVGhlb3J5V2FmUnVsZUNvbmZpZyA9IHByb3BzLndhZkNvbmZpZyA/PyB7XG4gICAgICBlbmFibGVSYXRlTGltaXQ6IHRydWUsXG4gICAgICByYXRlTGltaXQ6IDIwMDAsXG4gICAgICBlbmFibGVTUUxpUHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgIGVuYWJsZVhTU1Byb3RlY3Rpb246IHRydWUsXG4gICAgICBlbmFibGVLbm93bkJhZElucHV0czogdHJ1ZSxcbiAgICB9O1xuXG4gICAgY29uc3QgdnBjRW5kcG9pbnRDb25maWc6IEFwcFRoZW9yeVZwY0VuZHBvaW50Q29uZmlnID0gcHJvcHMudnBjRW5kcG9pbnRDb25maWcgPz8ge1xuICAgICAgZW5hYmxlU2VjcmV0c01hbmFnZXI6IHRydWUsXG4gICAgICBlbmFibGVDbG91ZFdhdGNoTG9nczogdHJ1ZSxcbiAgICAgIGVuYWJsZVhSYXk6IHRydWUsXG4gICAgICBlbmFibGVLbXM6IGZhbHNlLFxuICAgICAgZW5hYmxlQ2xvdWRXYXRjaE1vbml0b3Jpbmc6IGZhbHNlLFxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXG4gICAgfTtcblxuICAgIHRoaXMuc2VjdXJpdHlHcm91cCA9IHRoaXMuY3JlYXRlU2VjdXJpdHlHcm91cCh7XG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIGluZ3Jlc3NSdWxlczogcHJvcHMuaW5ncmVzc1J1bGVzID8/IFtdLFxuICAgICAgZWdyZXNzUnVsZXM6IHByb3BzLmVncmVzc1J1bGVzID8/IFtdLFxuICAgIH0pO1xuXG4gICAgaWYgKGVuYWJsZVdhZikge1xuICAgICAgY29uc3QgYnVpbGRlciA9IG5ldyBXYWZCdWlsZGVyKHRoaXMsIHdhZkNvbmZpZywgdGhpcy5hcHBsaWNhdGlvbk5hbWUsIHRoaXMuZW52aXJvbm1lbnQpO1xuICAgICAgdGhpcy53YWYgPSBidWlsZGVyLmJ1aWxkKCk7XG4gICAgfVxuXG4gICAgdGhpcy5jcmVhdGVTZWNyZXRzKHByb3BzLnNlY3JldHMgPz8gW10sIHRoaXMuYXBwbGljYXRpb25OYW1lLCB0aGlzLmVudmlyb25tZW50KTtcbiAgICB0aGlzLmNyZWF0ZVZwY0VuZHBvaW50cyhwcm9wcy52cGMsIHZwY0VuZHBvaW50Q29uZmlnKTtcblxuICAgIGlmIChlbmFibGVWcGNGbG93TG9ncykge1xuICAgICAgdGhpcy52cGNGbG93TG9nc0dyb3VwID0gdGhpcy5lbmFibGVWcGNGbG93TG9ncyhwcm9wcy52cGMsIHRoaXMuYXBwbGljYXRpb25OYW1lKTtcbiAgICB9XG5cbiAgICB0aGlzLmNvbmZpZ3VyZVNlY3VyaXR5TW9uaXRvcmluZygpO1xuICB9XG5cbiAgd2FmV2ViQWNsKCk6IHdhZnYyLkNmbldlYkFDTCB7XG4gICAgaWYgKCF0aGlzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiV0FGIGlzIG5vdCBlbmFibGVkXCIpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy53YWY7XG4gIH1cblxuICBzZWN1cml0eUdyb3VwUmVzb3VyY2UoKTogZWMyLklTZWN1cml0eUdyb3VwIHtcbiAgICByZXR1cm4gdGhpcy5zZWN1cml0eUdyb3VwO1xuICB9XG5cbiAgc2VjcmV0KG5hbWU6IHN0cmluZyk6IHNlY3JldHNtYW5hZ2VyLlNlY3JldCB7XG4gICAgY29uc3Qgc2VjcmV0ID0gdGhpcy5zZWNyZXRzW25hbWVdO1xuICAgIGlmICghc2VjcmV0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gc2VjcmV0OiAke25hbWV9YCk7XG4gICAgfVxuICAgIHJldHVybiBzZWNyZXQ7XG4gIH1cblxuICB2cGNFbmRwb2ludChuYW1lOiBzdHJpbmcpOiBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnQge1xuICAgIGNvbnN0IGVuZHBvaW50ID0gdGhpcy52cGNFbmRwb2ludHNbbmFtZV07XG4gICAgaWYgKCFlbmRwb2ludCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIFZQQyBlbmRwb2ludDogJHtuYW1lfWApO1xuICAgIH1cbiAgICByZXR1cm4gZW5kcG9pbnQ7XG4gIH1cblxuICBzZWN1cml0eU1ldHJpYyhuYW1lOiBzdHJpbmcpOiBjbG91ZHdhdGNoLklNZXRyaWMge1xuICAgIGNvbnN0IG1ldHJpYyA9IHRoaXMuc2VjdXJpdHlNZXRyaWNzW25hbWVdO1xuICAgIGlmICghbWV0cmljKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gc2VjdXJpdHkgbWV0cmljOiAke25hbWV9YCk7XG4gICAgfVxuICAgIHJldHVybiBtZXRyaWM7XG4gIH1cblxuICBhZGRDdXN0b21TZWN1cml0eVJ1bGUocnVsZTogQXBwVGhlb3J5U2VjdXJpdHlSdWxlLCBkaXJlY3Rpb246IFwiaW5ncmVzc1wiIHwgXCJlZ3Jlc3NcIik6IHZvaWQge1xuICAgIGlmIChkaXJlY3Rpb24gPT09IFwiaW5ncmVzc1wiKSB7XG4gICAgICB0aGlzLnNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoXG4gICAgICAgIHJ1bGUuc291cmNlLFxuICAgICAgICBwb3J0Rm9yUnVsZShydWxlLnBvcnQsIHJ1bGUucHJvdG9jb2wpLFxuICAgICAgICBydWxlLmRlc2NyaXB0aW9uLFxuICAgICAgICBmYWxzZSxcbiAgICAgICk7XG4gICAgICB0aGlzLmNyZWF0ZVNlY3VyaXR5UnVsZU1ldHJpYyhcImluZ3Jlc3NfY3VzdG9tXCIsIHJ1bGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuc2VjdXJpdHlHcm91cC5hZGRFZ3Jlc3NSdWxlKHJ1bGUuc291cmNlLCBwb3J0Rm9yUnVsZShydWxlLnBvcnQsIHJ1bGUucHJvdG9jb2wpLCBydWxlLmRlc2NyaXB0aW9uLCBmYWxzZSk7XG4gICAgdGhpcy5jcmVhdGVTZWN1cml0eVJ1bGVNZXRyaWMoXCJlZ3Jlc3NfY3VzdG9tXCIsIHJ1bGUpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWN1cml0eUdyb3VwKGFyZ3M6IHtcbiAgICB2cGM6IGVjMi5JVnBjO1xuICAgIGluZ3Jlc3NSdWxlczogQXBwVGhlb3J5U2VjdXJpdHlSdWxlW107XG4gICAgZWdyZXNzUnVsZXM6IEFwcFRoZW9yeVNlY3VyaXR5UnVsZVtdO1xuICB9KTogZWMyLlNlY3VyaXR5R3JvdXAge1xuICAgIGNvbnN0IGdyb3VwID0gbmV3IGVjMi5TZWN1cml0eUdyb3VwKHRoaXMsIFwiU2VjdXJpdHlHcm91cFwiLCB7XG4gICAgICB2cGM6IGFyZ3MudnBjLFxuICAgICAgZGVzY3JpcHRpb246IGBTZWN1cml0eSBncm91cCBmb3IgJHt0aGlzLmFwcGxpY2F0aW9uTmFtZX1gLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogZmFsc2UsXG4gICAgICBkaXNhYmxlSW5saW5lUnVsZXM6IHRydWUsXG4gICAgfSk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MuaW5ncmVzc1J1bGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBydWxlID0gYXJncy5pbmdyZXNzUnVsZXNbaV07XG4gICAgICBncm91cC5hZGRJbmdyZXNzUnVsZShydWxlLnNvdXJjZSwgcG9ydEZvclJ1bGUocnVsZS5wb3J0LCBydWxlLnByb3RvY29sKSwgcnVsZS5kZXNjcmlwdGlvbiwgZmFsc2UpO1xuICAgICAgdGhpcy5jcmVhdGVTZWN1cml0eVJ1bGVNZXRyaWMoYEluZ3Jlc3NSdWxlJHtpfWAsIHJ1bGUpO1xuICAgIH1cblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5lZ3Jlc3NSdWxlcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgcnVsZSA9IGFyZ3MuZWdyZXNzUnVsZXNbaV07XG4gICAgICBncm91cC5hZGRFZ3Jlc3NSdWxlKHJ1bGUuc291cmNlLCBwb3J0Rm9yUnVsZShydWxlLnBvcnQsIHJ1bGUucHJvdG9jb2wpLCBydWxlLmRlc2NyaXB0aW9uLCBmYWxzZSk7XG4gICAgICB0aGlzLmNyZWF0ZVNlY3VyaXR5UnVsZU1ldHJpYyhgRWdyZXNzUnVsZSR7aX1gLCBydWxlKTtcbiAgICB9XG5cbiAgICBncm91cC5hZGRFZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDQ0MyksIFwiQWxsb3cgSFRUUFMgdG8gQVdTIHNlcnZpY2VzXCIsIGZhbHNlKTtcbiAgICBncm91cC5hZGRFZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudWRwKDUzKSwgXCJBbGxvdyBETlMgcmVzb2x1dGlvblwiLCBmYWxzZSk7XG5cbiAgICBUYWdzLm9mKGdyb3VwKS5hZGQoXCJFbnZpcm9ubWVudFwiLCB0aGlzLmVudmlyb25tZW50KTtcbiAgICBUYWdzLm9mKGdyb3VwKS5hZGQoXCJBcHBsaWNhdGlvblwiLCB0aGlzLmFwcGxpY2F0aW9uTmFtZSk7XG4gICAgVGFncy5vZihncm91cCkuYWRkKFwiU2VjdXJpdHlMZXZlbFwiLCBcIkVuaGFuY2VkXCIpO1xuXG4gICAgcmV0dXJuIGdyb3VwO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZWN1cml0eVJ1bGVNZXRyaWMocnVsZUlkOiBzdHJpbmcsIHJ1bGU6IEFwcFRoZW9yeVNlY3VyaXR5UnVsZSk6IHZvaWQge1xuICAgIGNvbnN0IG1ldHJpY05hbWUgPSBgVHJhZmZpY18ke3J1bGVJZH1gO1xuICAgIHRoaXMuc2VjdXJpdHlNZXRyaWNzW21ldHJpY05hbWVdID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogXCJTZWN1cml0eS9OZXR3b3JrUnVsZXNcIixcbiAgICAgIG1ldHJpY05hbWUsXG4gICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgIFJ1bGVJZDogcnVsZUlkLFxuICAgICAgICBQb3J0OiBTdHJpbmcoTWF0aC50cnVuYyhydWxlLnBvcnQpKSxcbiAgICAgICAgUHJvdG9jb2w6IFN0cmluZyhydWxlLnByb3RvY29sKSxcbiAgICAgIH0sXG4gICAgICBzdGF0aXN0aWM6IFwiU3VtXCIsXG4gICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3JldHMoY29uZmlnczogQXBwVGhlb3J5U2VjcmV0Q29uZmlnW10sIGFwcGxpY2F0aW9uTmFtZTogc3RyaW5nLCBlbnZpcm9ubWVudDogc3RyaW5nKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjb25maWcgb2YgY29uZmlncykge1xuICAgICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCBjb25maWcubmFtZSwge1xuICAgICAgICBkZXNjcmlwdGlvbjogY29uZmlnLmRlc2NyaXB0aW9uLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgLi4uKGNvbmZpZy50ZW1wbGF0ZVxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICAgICAgICAgIHNlY3JldFN0cmluZ1RlbXBsYXRlOiBjb25maWcudGVtcGxhdGUsXG4gICAgICAgICAgICAgICAgZ2VuZXJhdGVTdHJpbmdLZXk6IGNvbmZpZy5nZW5lcmF0ZUtleSA/PyBcInBhc3N3b3JkXCIsXG4gICAgICAgICAgICAgICAgZXhjbHVkZUNoYXJhY3RlcnM6IGNvbmZpZy5leGNsdWRlQ2hhcnMgPz8gXCJcIixcbiAgICAgICAgICAgICAgICBwYXNzd29yZExlbmd0aDogY29uZmlnLmxlbmd0aCA/PyAzMixcbiAgICAgICAgICAgICAgICBleGNsdWRlUHVuY3R1YXRpb246IHRydWUsXG4gICAgICAgICAgICAgICAgZXhjbHVkZU51bWJlcnM6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGV4Y2x1ZGVMb3dlcmNhc2U6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGV4Y2x1ZGVVcHBlcmNhc2U6IGZhbHNlLFxuICAgICAgICAgICAgICAgIHJlcXVpcmVFYWNoSW5jbHVkZWRUeXBlOiB0cnVlLFxuICAgICAgICAgICAgICB9IGFzIHNlY3JldHNtYW5hZ2VyLlNlY3JldFN0cmluZ0dlbmVyYXRvcixcbiAgICAgICAgICAgIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoY29uZmlnLmVuYWJsZVJvdGF0aW9uKSB7XG4gICAgICAgIGNvbnN0IHJvdGF0aW9uU2NoZWR1bGU6IHNlY3JldHNtYW5hZ2VyLlJvdGF0aW9uU2NoZWR1bGVPcHRpb25zID0ge1xuICAgICAgICAgIC4uLihjb25maWcucm90YXRpb25TY2hlZHVsZSA/PyB7IGF1dG9tYXRpY2FsbHlBZnRlcjogRHVyYXRpb24uZGF5cygzMCkgfSksXG4gICAgICAgICAgLi4uKGNvbmZpZy5yb3RhdGlvbkxhbWJkYSA/IHsgcm90YXRpb25MYW1iZGE6IGNvbmZpZy5yb3RhdGlvbkxhbWJkYSB9IDoge30pLFxuICAgICAgICB9O1xuICAgICAgICBzZWNyZXQuYWRkUm90YXRpb25TY2hlZHVsZShgJHtjb25maWcubmFtZX1Sb3RhdGlvbmAsIHJvdGF0aW9uU2NoZWR1bGUpO1xuICAgICAgfVxuXG4gICAgICBUYWdzLm9mKHNlY3JldCkuYWRkKFwiRW52aXJvbm1lbnRcIiwgZW52aXJvbm1lbnQpO1xuICAgICAgVGFncy5vZihzZWNyZXQpLmFkZChcIkFwcGxpY2F0aW9uXCIsIGFwcGxpY2F0aW9uTmFtZSk7XG4gICAgICBUYWdzLm9mKHNlY3JldCkuYWRkKFwiRGF0YUNsYXNzaWZpY2F0aW9uXCIsIFwiQ29uZmlkZW50aWFsXCIpO1xuXG4gICAgICB0aGlzLnNlY3JldHNbY29uZmlnLm5hbWVdID0gc2VjcmV0O1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlVnBjRW5kcG9pbnRzKHZwYzogZWMyLklWcGMsIGNvbmZpZzogQXBwVGhlb3J5VnBjRW5kcG9pbnRDb25maWcpOiB2b2lkIHtcbiAgICBjb25zdCBwcml2YXRlRG5zRW5hYmxlZCA9IGNvbmZpZy5wcml2YXRlRG5zRW5hYmxlZCA/PyB0cnVlO1xuXG4gICAgY29uc3QgbWsgPSAobmFtZTogc3RyaW5nLCBzZXJ2aWNlOiBlYzIuSUludGVyZmFjZVZwY0VuZHBvaW50U2VydmljZSk6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCA9PlxuICAgICAgbmV3IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCh0aGlzLCBgJHtuYW1lfUVuZHBvaW50YCwge1xuICAgICAgICB2cGMsXG4gICAgICAgIHNlcnZpY2UsXG4gICAgICAgIHNlY3VyaXR5R3JvdXBzOiBbdGhpcy5zZWN1cml0eUdyb3VwXSxcbiAgICAgICAgcHJpdmF0ZURuc0VuYWJsZWQsXG4gICAgICAgIHN1Ym5ldHM6IHsgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFJJVkFURV9XSVRIX0VHUkVTUyB9LFxuICAgICAgfSk7XG5cbiAgICBpZiAoY29uZmlnLmVuYWJsZVNlY3JldHNNYW5hZ2VyKSB7XG4gICAgICB0aGlzLnZwY0VuZHBvaW50c1tcIlNlY3JldHNNYW5hZ2VyXCJdID0gbWsoXCJTZWNyZXRzTWFuYWdlclwiLCBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLlNFQ1JFVFNfTUFOQUdFUik7XG4gICAgfVxuICAgIGlmIChjb25maWcuZW5hYmxlQ2xvdWRXYXRjaExvZ3MpIHtcbiAgICAgIHRoaXMudnBjRW5kcG9pbnRzW1wiQ2xvdWRXYXRjaExvZ3NcIl0gPSBtayhcIkNsb3VkV2F0Y2hMb2dzXCIsIGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuQ0xPVURXQVRDSF9MT0dTKTtcbiAgICB9XG4gICAgaWYgKGNvbmZpZy5lbmFibGVYUmF5KSB7XG4gICAgICB0aGlzLnZwY0VuZHBvaW50c1tcIlhSYXlcIl0gPSBtayhcIlhSYXlcIiwgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5YUkFZKTtcbiAgICB9XG4gICAgaWYgKGNvbmZpZy5lbmFibGVLbXMpIHtcbiAgICAgIHRoaXMudnBjRW5kcG9pbnRzW1wiS01TXCJdID0gbWsoXCJLTVNcIiwgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5LTVMpO1xuICAgIH1cbiAgICBpZiAoY29uZmlnLmVuYWJsZUNsb3VkV2F0Y2hNb25pdG9yaW5nKSB7XG4gICAgICB0aGlzLnZwY0VuZHBvaW50c1tcIkNsb3VkV2F0Y2hNb25pdG9yaW5nXCJdID0gbWsoXG4gICAgICAgIFwiQ2xvdWRXYXRjaE1vbml0b3JpbmdcIixcbiAgICAgICAgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX01PTklUT1JJTkcsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgZW5hYmxlVnBjRmxvd0xvZ3ModnBjOiBlYzIuSVZwYywgYXBwbGljYXRpb25OYW1lOiBzdHJpbmcpOiBsb2dzLkxvZ0dyb3VwIHtcbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiVlBDRmxvd0xvZ3NHcm91cFwiLCB7XG4gICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL3ZwYy9mbG93bG9ncy8ke2FwcGxpY2F0aW9uTmFtZX1gLFxuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiVlBDRmxvd0xvZ3NSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwidnBjLWZsb3ctbG9ncy5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgRmxvd0xvZ3NEZWxpdmVyeVJvbGVQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOlB1dExvZ0V2ZW50c1wiLCBcImxvZ3M6RGVzY3JpYmVMb2dHcm91cHNcIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgbmV3IGVjMi5GbG93TG9nKHRoaXMsIFwiVlBDRmxvd0xvZ3NcIiwge1xuICAgICAgcmVzb3VyY2VUeXBlOiBlYzIuRmxvd0xvZ1Jlc291cmNlVHlwZS5mcm9tVnBjKHZwYyksXG4gICAgICBkZXN0aW5hdGlvbjogZWMyLkZsb3dMb2dEZXN0aW5hdGlvbi50b0Nsb3VkV2F0Y2hMb2dzKGxvZ0dyb3VwLCByb2xlKSxcbiAgICAgIHRyYWZmaWNUeXBlOiBlYzIuRmxvd0xvZ1RyYWZmaWNUeXBlLkFMTCxcbiAgICAgIG1heEFnZ3JlZ2F0aW9uSW50ZXJ2YWw6IGVjMi5GbG93TG9nTWF4QWdncmVnYXRpb25JbnRlcnZhbC5PTkVfTUlOVVRFLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxvZ0dyb3VwO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVTZWN1cml0eU1vbml0b3JpbmcoKTogdm9pZCB7XG4gICAgdGhpcy5zZWN1cml0eU1ldHJpY3NbXCJXQUZCbG9ja2VkUmVxdWVzdHNcIl0gPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiBcIkFXUy9XQUZWMlwiLFxuICAgICAgbWV0cmljTmFtZTogXCJCbG9ja2VkUmVxdWVzdHNcIixcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgV2ViQUNMOiBgJHt0aGlzLmFwcGxpY2F0aW9uTmFtZX1XQUZgLFxuICAgICAgICBSZWdpb246IFN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgIH0sXG4gICAgICBzdGF0aXN0aWM6IFwiU3VtXCIsXG4gICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgfSk7XG5cbiAgICB0aGlzLnNlY3VyaXR5TWV0cmljc1tcIlNlY3VyaXR5R3JvdXBDaGFuZ2VzXCJdID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogXCJBV1MvRXZlbnRzXCIsXG4gICAgICBtZXRyaWNOYW1lOiBcIlNlY3VyaXR5R3JvdXBDaGFuZ2VzXCIsXG4gICAgICBkaW1lbnNpb25zTWFwOiB7XG4gICAgICAgIEFwcGxpY2F0aW9uOiB0aGlzLmFwcGxpY2F0aW9uTmFtZSxcbiAgICAgICAgRW52aXJvbm1lbnQ6IHRoaXMuZW52aXJvbm1lbnQsXG4gICAgICB9LFxuICAgICAgc3RhdGlzdGljOiBcIlN1bVwiLFxuICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMudnBjRmxvd0xvZ3NHcm91cCkge1xuICAgICAgbmV3IGxvZ3MuTWV0cmljRmlsdGVyKHRoaXMsIFwiUmVqZWN0ZWRDb25uZWN0aW9uc0ZpbHRlclwiLCB7XG4gICAgICAgIGxvZ0dyb3VwOiB0aGlzLnZwY0Zsb3dMb2dzR3JvdXAsXG4gICAgICAgIG1ldHJpY05hbWVzcGFjZTogXCJTZWN1cml0eS9WUENcIixcbiAgICAgICAgbWV0cmljTmFtZTogXCJSZWplY3RlZENvbm5lY3Rpb25zXCIsXG4gICAgICAgIGZpbHRlclBhdHRlcm46IGxvZ3MuRmlsdGVyUGF0dGVybi5zcGFjZURlbGltaXRlZChcbiAgICAgICAgICBcInZlcnNpb25cIixcbiAgICAgICAgICBcImFjY291bnRcIixcbiAgICAgICAgICBcImVuaVwiLFxuICAgICAgICAgIFwic291cmNlXCIsXG4gICAgICAgICAgXCJkZXN0aW5hdGlvblwiLFxuICAgICAgICAgIFwic3JjcG9ydFwiLFxuICAgICAgICAgIFwiZGVzdHBvcnRcIixcbiAgICAgICAgICBcInByb3RvY29sXCIsXG4gICAgICAgICAgXCJwYWNrZXRzXCIsXG4gICAgICAgICAgXCJieXRlc1wiLFxuICAgICAgICAgIFwid2luZG93c3RhcnRcIixcbiAgICAgICAgICBcIndpbmRvd2VuZFwiLFxuICAgICAgICAgIFwiYWN0aW9uXCIsXG4gICAgICAgICAgXCJmbG93bG9nc3RhdHVzXCIsXG4gICAgICAgICkud2hlcmVTdHJpbmcoXCJhY3Rpb25cIiwgXCI9XCIsIFwiUkVKRUNUXCIpLFxuICAgICAgICBtZXRyaWNWYWx1ZTogXCIxXCIsXG4gICAgICAgIGRlZmF1bHRWYWx1ZTogMCxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgbG9ncy5NZXRyaWNGaWx0ZXIodGhpcywgXCJTdXNwaWNpb3VzUG9ydHNGaWx0ZXJcIiwge1xuICAgICAgICBsb2dHcm91cDogdGhpcy52cGNGbG93TG9nc0dyb3VwLFxuICAgICAgICBtZXRyaWNOYW1lc3BhY2U6IFwiU2VjdXJpdHkvVlBDXCIsXG4gICAgICAgIG1ldHJpY05hbWU6IFwiU3VzcGljaW91c1BvcnRBY3Rpdml0eVwiLFxuICAgICAgICBmaWx0ZXJQYXR0ZXJuOiBsb2dzLkZpbHRlclBhdHRlcm4uYW55VGVybShcImRlc3Rwb3J0PTIyXCIsIFwiZGVzdHBvcnQ9MjNcIiwgXCJkZXN0cG9ydD0zMzg5XCIpLFxuICAgICAgICBtZXRyaWNWYWx1ZTogXCIxXCIsXG4gICAgICAgIGRlZmF1bHRWYWx1ZTogMCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBwb3J0Rm9yUnVsZShwb3J0OiBudW1iZXIsIHByb3RvY29sOiBlYzIuUHJvdG9jb2wpOiBlYzIuUG9ydCB7XG4gIHN3aXRjaCAocHJvdG9jb2wpIHtcbiAgICBjYXNlIGVjMi5Qcm90b2NvbC5UQ1A6XG4gICAgICByZXR1cm4gZWMyLlBvcnQudGNwKHBvcnQpO1xuICAgIGNhc2UgZWMyLlByb3RvY29sLlVEUDpcbiAgICAgIHJldHVybiBlYzIuUG9ydC51ZHAocG9ydCk7XG4gICAgY2FzZSBlYzIuUHJvdG9jb2wuQUxMOlxuICAgICAgcmV0dXJuIGVjMi5Qb3J0LmFsbFRyYWZmaWMoKTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGVjMi5Qb3J0LnRjcChwb3J0KTtcbiAgfVxufVxuXG5jbGFzcyBXYWZCdWlsZGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBydWxlczogd2FmdjIuQ2ZuV2ViQUNMLlJ1bGVQcm9wZXJ0eVtdID0gW107XG4gIHByaXZhdGUgcHJpb3JpdHkgPSAxO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc2NvcGU6IENvbnN0cnVjdCxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvbmZpZzogQXBwVGhlb3J5V2FmUnVsZUNvbmZpZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGFwcGxpY2F0aW9uTmFtZTogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgZW52aXJvbm1lbnQ6IHN0cmluZyxcbiAgKSB7fVxuXG4gIGJ1aWxkKCk6IHdhZnYyLkNmbldlYkFDTCB7XG4gICAgdGhpcy5hZGRSYXRlTGltaXRSdWxlKCk7XG4gICAgdGhpcy5hZGRNYW5hZ2VkUnVsZXMoKTtcbiAgICB0aGlzLmFkZElwUnVsZXMoKTtcbiAgICB0aGlzLmFkZEdlb0Jsb2NraW5nUnVsZSgpO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVdlYkFjbCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRSYXRlTGltaXRSdWxlKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb25maWcuZW5hYmxlUmF0ZUxpbWl0KSByZXR1cm47XG5cbiAgICBjb25zdCBsaW1pdCA9IHRoaXMuY29uZmlnLnJhdGVMaW1pdCA/PyAyMDAwO1xuICAgIHRoaXMucnVsZXMucHVzaCh7XG4gICAgICBuYW1lOiBcIlJhdGVMaW1pdFJ1bGVcIixcbiAgICAgIHByaW9yaXR5OiB0aGlzLnByaW9yaXR5KyssXG4gICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgcmF0ZUJhc2VkU3RhdGVtZW50OiB7XG4gICAgICAgICAgbGltaXQsXG4gICAgICAgICAgYWdncmVnYXRlS2V5VHlwZTogXCJJUFwiLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIGFjdGlvbjoge1xuICAgICAgICBibG9jazoge1xuICAgICAgICAgIGN1c3RvbVJlc3BvbnNlOiB7XG4gICAgICAgICAgICByZXNwb25zZUNvZGU6IDQyOSxcbiAgICAgICAgICAgIGN1c3RvbVJlc3BvbnNlQm9keUtleTogXCJSYXRlTGltaXRFeGNlZWRlZFwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzogdmlzaWJpbGl0eUNvbmZpZyhcIlJhdGVMaW1pdFJ1bGVcIiksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGFkZE1hbmFnZWRSdWxlcygpOiB2b2lkIHtcbiAgICBjb25zdCBtYW5hZ2VkID0gW1xuICAgICAgeyBlbmFibGVkOiB0aGlzLmNvbmZpZy5lbmFibGVTUUxpUHJvdGVjdGlvbiwgbmFtZTogXCJTUUxpUHJvdGVjdGlvblwiLCBydWxlU2V0OiBcIkFXU01hbmFnZWRSdWxlc1NRTGlSdWxlU2V0XCIgfSxcbiAgICAgIHsgZW5hYmxlZDogdGhpcy5jb25maWcuZW5hYmxlWFNTUHJvdGVjdGlvbiwgbmFtZTogXCJYU1NQcm90ZWN0aW9uXCIsIHJ1bGVTZXQ6IFwiQVdTTWFuYWdlZFJ1bGVzQ29tbW9uUnVsZVNldFwiIH0sXG4gICAgICB7IGVuYWJsZWQ6IHRoaXMuY29uZmlnLmVuYWJsZUtub3duQmFkSW5wdXRzLCBuYW1lOiBcIktub3duQmFkSW5wdXRzXCIsIHJ1bGVTZXQ6IFwiQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0XCIgfSxcbiAgICBdO1xuXG4gICAgZm9yIChjb25zdCBydWxlIG9mIG1hbmFnZWQpIHtcbiAgICAgIGlmICghcnVsZS5lbmFibGVkKSBjb250aW51ZTtcbiAgICAgIHRoaXMucnVsZXMucHVzaChtYW5hZ2VkV2FmUnVsZShydWxlLm5hbWUsIHJ1bGUucnVsZVNldCwgdGhpcy5wcmlvcml0eSsrKSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRJcFJ1bGVzKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmNvbmZpZy5pcFdoaXRlbGlzdCAmJiB0aGlzLmNvbmZpZy5pcFdoaXRlbGlzdC5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnJ1bGVzLnB1c2godGhpcy5jcmVhdGVJcFJ1bGUoXCJJUFdoaXRlbGlzdFwiLCBcIldoaXRlbGlzdFwiLCB0aGlzLmNvbmZpZy5pcFdoaXRlbGlzdCwgdHJ1ZSkpO1xuICAgICAgdGhpcy5wcmlvcml0eSsrO1xuICAgIH1cbiAgICBpZiAodGhpcy5jb25maWcuaXBCbGFja2xpc3QgJiYgdGhpcy5jb25maWcuaXBCbGFja2xpc3QubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5ydWxlcy5wdXNoKHRoaXMuY3JlYXRlSXBSdWxlKFwiSVBCbGFja2xpc3RcIiwgXCJCbGFja2xpc3RcIiwgdGhpcy5jb25maWcuaXBCbGFja2xpc3QsIGZhbHNlKSk7XG4gICAgICB0aGlzLnByaW9yaXR5Kys7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVJcFJ1bGUobmFtZTogc3RyaW5nLCBpcFNldE5hbWU6IHN0cmluZywgaXBzOiBzdHJpbmdbXSwgYWxsb3c6IGJvb2xlYW4pOiB3YWZ2Mi5DZm5XZWJBQ0wuUnVsZVByb3BlcnR5IHtcbiAgICByZXR1cm4ge1xuICAgICAgbmFtZSxcbiAgICAgIHByaW9yaXR5OiB0aGlzLnByaW9yaXR5LFxuICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgIGlwU2V0UmVmZXJlbmNlU3RhdGVtZW50OiB7XG4gICAgICAgICAgYXJuOiB0aGlzLmNyZWF0ZUlwU2V0KGlwU2V0TmFtZSwgaXBzKSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICAuLi4oYWxsb3dcbiAgICAgICAgPyB7IGFjdGlvbjogeyBhbGxvdzoge30gfSB9XG4gICAgICAgIDogeyBhY3Rpb246IHsgYmxvY2s6IHt9IH0gfSksXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB2aXNpYmlsaXR5Q29uZmlnKG5hbWUpLFxuICAgIH07XG4gIH1cblxuICBwcml2YXRlIGFkZEdlb0Jsb2NraW5nUnVsZSgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnLmdlb0Jsb2NraW5nIHx8IHRoaXMuY29uZmlnLmdlb0Jsb2NraW5nLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgdGhpcy5ydWxlcy5wdXNoKHtcbiAgICAgIG5hbWU6IFwiR2VvQmxvY2tpbmdcIixcbiAgICAgIHByaW9yaXR5OiB0aGlzLnByaW9yaXR5KyssXG4gICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgZ2VvTWF0Y2hTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICBjb3VudHJ5Q29kZXM6IHRoaXMuY29uZmlnLmdlb0Jsb2NraW5nLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIGFjdGlvbjogeyBibG9jazoge30gfSxcbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHZpc2liaWxpdHlDb25maWcoXCJHZW9CbG9ja2luZ1wiKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlV2ViQWNsKCk6IHdhZnYyLkNmbldlYkFDTCB7XG4gICAgY29uc3QgZGVmYXVsdEFjdGlvbiA9XG4gICAgICB0aGlzLmNvbmZpZy5pcFdoaXRlbGlzdCAmJiB0aGlzLmNvbmZpZy5pcFdoaXRlbGlzdC5sZW5ndGggPiAwXG4gICAgICAgID8ge1xuICAgICAgICAgICAgYmxvY2s6IHtcbiAgICAgICAgICAgICAgY3VzdG9tUmVzcG9uc2U6IHtcbiAgICAgICAgICAgICAgICByZXNwb25zZUNvZGU6IDQwMyxcbiAgICAgICAgICAgICAgICBjdXN0b21SZXNwb25zZUJvZHlLZXk6IFwiQWNjZXNzRGVuaWVkXCIsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB7IGFsbG93OiB7fSB9O1xuXG4gICAgcmV0dXJuIG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcy5zY29wZSwgXCJXZWJBQ0xcIiwge1xuICAgICAgc2NvcGU6IFwiUkVHSU9OQUxcIixcbiAgICAgIGRlZmF1bHRBY3Rpb24sXG4gICAgICBydWxlczogdGhpcy5ydWxlcyxcbiAgICAgIGN1c3RvbVJlc3BvbnNlQm9kaWVzOiB7XG4gICAgICAgIFJhdGVMaW1pdEV4Y2VlZGVkOiB7XG4gICAgICAgICAgY29udGVudFR5cGU6IFwiQVBQTElDQVRJT05fSlNPTlwiLFxuICAgICAgICAgIGNvbnRlbnQ6IGB7XCJlcnJvclwiOiBcInJhdGVfbGltaXRfZXhjZWVkZWRcIiwgXCJtZXNzYWdlXCI6IFwiVG9vIG1hbnkgcmVxdWVzdHNcIiwgXCJyZXRyeV9hZnRlclwiOiA2MH1gLFxuICAgICAgICB9LFxuICAgICAgICBBY2Nlc3NEZW5pZWQ6IHtcbiAgICAgICAgICBjb250ZW50VHlwZTogXCJBUFBMSUNBVElPTl9KU09OXCIsXG4gICAgICAgICAgY29udGVudDogYHtcImVycm9yXCI6IFwiYWNjZXNzX2RlbmllZFwiLCBcIm1lc3NhZ2VcIjogXCJBY2Nlc3MgZGVuaWVkIGJ5IHNlY3VyaXR5IHBvbGljeVwifWAsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY05hbWU6IGAke3RoaXMuYXBwbGljYXRpb25OYW1lfVdBRmAsXG4gICAgICB9LFxuICAgICAgdGFnczogW1xuICAgICAgICB7IGtleTogXCJFbnZpcm9ubWVudFwiLCB2YWx1ZTogdGhpcy5lbnZpcm9ubWVudCB9LFxuICAgICAgICB7IGtleTogXCJBcHBsaWNhdGlvblwiLCB2YWx1ZTogdGhpcy5hcHBsaWNhdGlvbk5hbWUgfSxcbiAgICAgIF0gYXMgQ2ZuVGFnW10sXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUlwU2V0KG5hbWU6IHN0cmluZywgaXBzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gICAgY29uc3QgaXBTZXQgPSBuZXcgd2FmdjIuQ2ZuSVBTZXQodGhpcy5zY29wZSwgYElQU2V0JHtuYW1lfWAsIHtcbiAgICAgIHNjb3BlOiBcIlJFR0lPTkFMXCIsXG4gICAgICBpcEFkZHJlc3NWZXJzaW9uOiBcIklQVjRcIixcbiAgICAgIGFkZHJlc3NlczogaXBzLFxuICAgICAgdGFnczogW3sga2V5OiBcIk5hbWVcIiwgdmFsdWU6IG5hbWUgfV0gYXMgQ2ZuVGFnW10sXG4gICAgfSk7XG4gICAgcmV0dXJuIGlwU2V0LmF0dHJBcm47XG4gIH1cbn1cblxuZnVuY3Rpb24gdmlzaWJpbGl0eUNvbmZpZyhtZXRyaWNOYW1lOiBzdHJpbmcpOiB3YWZ2Mi5DZm5XZWJBQ0wuVmlzaWJpbGl0eUNvbmZpZ1Byb3BlcnR5IHtcbiAgcmV0dXJuIHtcbiAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICBtZXRyaWNOYW1lLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYW5hZ2VkV2FmUnVsZShuYW1lOiBzdHJpbmcsIHJ1bGVTZXQ6IHN0cmluZywgcHJpb3JpdHk6IG51bWJlcik6IHdhZnYyLkNmbldlYkFDTC5SdWxlUHJvcGVydHkge1xuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgcHJpb3JpdHksXG4gICAgc3RhdGVtZW50OiB7XG4gICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgIHZlbmRvck5hbWU6IFwiQVdTXCIsXG4gICAgICAgIG5hbWU6IHJ1bGVTZXQsXG4gICAgICB9LFxuICAgIH0sXG4gICAgb3ZlcnJpZGVBY3Rpb246IHsgbm9uZToge30gfSxcbiAgICB2aXNpYmlsaXR5Q29uZmlnOiB2aXNpYmlsaXR5Q29uZmlnKG5hbWUpLFxuICB9O1xufVxuIl19