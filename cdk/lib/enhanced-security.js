"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryEnhancedSecurity = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const ec2 = require("aws-cdk-lib/aws-ec2");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const secretsmanager = require("aws-cdk-lib/aws-secretsmanager");
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const constructs_1 = require("constructs");
class AppTheoryEnhancedSecurity extends constructs_1.Construct {
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryEnhancedSecurity[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryEnhancedSecurity", version: "0.2.0-rc.2" };
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
    constructor(scope, config, applicationName, environment) {
        this.scope = scope;
        this.config = config;
        this.applicationName = applicationName;
        this.environment = environment;
        this.rules = [];
        this.priority = 1;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW5oYW5jZWQtc2VjdXJpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlbmhhbmNlZC1zZWN1cml0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUEyRTtBQUMzRSx5REFBeUQ7QUFDekQsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUUzQyw2Q0FBNkM7QUFDN0MsaUVBQWlFO0FBQ2pFLCtDQUErQztBQUMvQywyQ0FBdUM7QUFzRHZDLE1BQWEseUJBQTBCLFNBQVEsc0JBQVM7SUFXdEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFxQztRQUM3RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1FBQ2xCLElBQUksQ0FBQyxlQUFlLEdBQUcsRUFBRSxDQUFDO1FBQzFCLElBQUksQ0FBQyxZQUFZLEdBQUcsRUFBRSxDQUFDO1FBRXZCLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxTQUFTLElBQUksSUFBSSxDQUFDO1FBQzFDLE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLGlCQUFpQixJQUFJLElBQUksQ0FBQztRQUUxRCxJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQyxXQUFXLElBQUksWUFBWSxDQUFDO1FBQ3JELElBQUksQ0FBQyxlQUFlLEdBQUcsS0FBSyxDQUFDLGVBQWUsSUFBSSxlQUFlLENBQUM7UUFFaEUsTUFBTSxTQUFTLEdBQTJCLEtBQUssQ0FBQyxTQUFTLElBQUk7WUFDM0QsZUFBZSxFQUFFLElBQUk7WUFDckIsU0FBUyxFQUFFLElBQUk7WUFDZixvQkFBb0IsRUFBRSxJQUFJO1lBQzFCLG1CQUFtQixFQUFFLElBQUk7WUFDekIsb0JBQW9CLEVBQUUsSUFBSTtTQUMzQixDQUFDO1FBRUYsTUFBTSxpQkFBaUIsR0FBK0IsS0FBSyxDQUFDLGlCQUFpQixJQUFJO1lBQy9FLG9CQUFvQixFQUFFLElBQUk7WUFDMUIsb0JB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QUFXLENBQUMsSUFBWSxFQUFFLEdBQWE7UUFDN0MsTUFBTSxLQUFLLEdBQUcsSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsUUFBUSxJQUFJLEVBQUUsRUFBRTtZQUMzRCxLQUFLLEVBQUUsVUFBVTtZQUNqQixnQkFBZ0IsRUFBRSxNQUFNO1lBQ3hCLFNBQVMsRUFBRSxHQUFHO1lBQ2QsSUFBSSxFQUFFLENBQUMsRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBYTtTQUNqRCxDQUFDLENBQUM7UUFDSCxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUM7SUFDdkIsQ0FBQztDQUNGO0FBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxVQUFrQjtJQUMxQyxPQUFPO1FBQ0wsc0JBQXNCLEVBQUUsSUFBSTtRQUM1Qix3QkFBd0IsRUFBRSxJQUFJO1FBQzlCLFVBQVU7S0FDWCxDQUFDO0FBQ0osQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLElBQVksRUFBRSxPQUFlLEVBQUUsUUFBZ0I7SUFDckUsT0FBTztRQUNMLElBQUk7UUFDSixRQUFRO1FBQ1IsU0FBUyxFQUFFO1lBQ1QseUJBQXlCLEVBQUU7Z0JBQ3pCLFVBQVUsRUFBRSxLQUFLO2dCQUNqQixJQUFJLEVBQUUsT0FBTzthQUNkO1NBQ0Y7UUFDRCxjQUFjLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFO1FBQzVCLGdCQUFnQixFQUFFLGdCQUFnQixDQUFDLElBQUksQ0FBQztLQUN6QyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmblRhZywgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUYWdzIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaFwiO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zZWNyZXRzbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSBcImF3cy1jZGstbGliL2F3cy13YWZ2MlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlTZWN1cml0eVJ1bGUge1xuICByZWFkb25seSBzb3VyY2U6IGVjMi5JUGVlcjtcbiAgcmVhZG9ubHkgcHJvdG9jb2w6IGVjMi5Qcm90b2NvbDtcbiAgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcbiAgcmVhZG9ubHkgcG9ydDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVNlY3JldENvbmZpZyB7XG4gIHJlYWRvbmx5IHJvdGF0aW9uTGFtYmRhPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgcm90YXRpb25TY2hlZHVsZT86IHNlY3JldHNtYW5hZ2VyLlJvdGF0aW9uU2NoZWR1bGVPcHRpb25zO1xuICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRlbXBsYXRlPzogc3RyaW5nO1xuICByZWFkb25seSBnZW5lcmF0ZUtleT86IHN0cmluZztcbiAgcmVhZG9ubHkgZXhjbHVkZUNoYXJzPzogc3RyaW5nO1xuICByZWFkb25seSBsZW5ndGg/OiBudW1iZXI7XG4gIHJlYWRvbmx5IGVuYWJsZVJvdGF0aW9uPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlXYWZSdWxlQ29uZmlnIHtcbiAgcmVhZG9ubHkgZW5hYmxlUmF0ZUxpbWl0PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcmF0ZUxpbWl0PzogbnVtYmVyO1xuICByZWFkb25seSBlbmFibGVTUUxpUHJvdGVjdGlvbj86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZVhTU1Byb3RlY3Rpb24/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVLbm93bkJhZElucHV0cz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGlwV2hpdGVsaXN0Pzogc3RyaW5nW107XG4gIHJlYWRvbmx5IGlwQmxhY2tsaXN0Pzogc3RyaW5nW107XG4gIHJlYWRvbmx5IGdlb0Jsb2NraW5nPzogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5VnBjRW5kcG9pbnRDb25maWcge1xuICByZWFkb25seSBlbmFibGVTZWNyZXRzTWFuYWdlcj86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZUNsb3VkV2F0Y2hMb2dzPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5hYmxlWFJheT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZUttcz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZUNsb3VkV2F0Y2hNb25pdG9yaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcHJpdmF0ZURuc0VuYWJsZWQ/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUVuaGFuY2VkU2VjdXJpdHlQcm9wcyB7XG4gIHJlYWRvbmx5IHZwYzogZWMyLklWcGM7XG4gIHJlYWRvbmx5IGVuYWJsZVdhZj86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHdhZkNvbmZpZz86IEFwcFRoZW9yeVdhZlJ1bGVDb25maWc7XG4gIHJlYWRvbmx5IGVuYWJsZVZwY0Zsb3dMb2dzPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW52aXJvbm1lbnQ/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFwcGxpY2F0aW9uTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgaW5ncmVzc1J1bGVzPzogQXBwVGhlb3J5U2VjdXJpdHlSdWxlW107XG4gIHJlYWRvbmx5IGVncmVzc1J1bGVzPzogQXBwVGhlb3J5U2VjdXJpdHlSdWxlW107XG4gIHJlYWRvbmx5IHNlY3JldHM/OiBBcHBUaGVvcnlTZWNyZXRDb25maWdbXTtcbiAgcmVhZG9ubHkgdnBjRW5kcG9pbnRDb25maWc/OiBBcHBUaGVvcnlWcGNFbmRwb2ludENvbmZpZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUVuaGFuY2VkU2VjdXJpdHkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgc2VjdXJpdHlHcm91cDogZWMyLlNlY3VyaXR5R3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSB3YWY/OiB3YWZ2Mi5DZm5XZWJBQ0w7XG4gIHB1YmxpYyByZWFkb25seSBzZWNyZXRzOiBSZWNvcmQ8c3RyaW5nLCBzZWNyZXRzbWFuYWdlci5TZWNyZXQ+O1xuICBwdWJsaWMgcmVhZG9ubHkgdnBjRmxvd0xvZ3NHcm91cD86IGxvZ3MuTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBzZWN1cml0eU1ldHJpY3M6IFJlY29yZDxzdHJpbmcsIGNsb3Vkd2F0Y2guSU1ldHJpYz47XG4gIHB1YmxpYyByZWFkb25seSB2cGNFbmRwb2ludHM6IFJlY29yZDxzdHJpbmcsIGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludD47XG5cbiAgcHJpdmF0ZSByZWFkb25seSBhcHBsaWNhdGlvbk5hbWU6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBlbnZpcm9ubWVudDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlFbmhhbmNlZFNlY3VyaXR5UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5zZWNyZXRzID0ge307XG4gICAgdGhpcy5zZWN1cml0eU1ldHJpY3MgPSB7fTtcbiAgICB0aGlzLnZwY0VuZHBvaW50cyA9IHt9O1xuXG4gICAgY29uc3QgZW5hYmxlV2FmID0gcHJvcHMuZW5hYmxlV2FmID8/IHRydWU7XG4gICAgY29uc3QgZW5hYmxlVnBjRmxvd0xvZ3MgPSBwcm9wcy5lbmFibGVWcGNGbG93TG9ncyA/PyB0cnVlO1xuXG4gICAgdGhpcy5lbnZpcm9ubWVudCA9IHByb3BzLmVudmlyb25tZW50ID8/IFwicHJvZHVjdGlvblwiO1xuICAgIHRoaXMuYXBwbGljYXRpb25OYW1lID0gcHJvcHMuYXBwbGljYXRpb25OYW1lID8/IFwiYXBwdGhlb3J5LWFwcFwiO1xuXG4gICAgY29uc3Qgd2FmQ29uZmlnOiBBcHBUaGVvcnlXYWZSdWxlQ29uZmlnID0gcHJvcHMud2FmQ29uZmlnID8/IHtcbiAgICAgIGVuYWJsZVJhdGVMaW1pdDogdHJ1ZSxcbiAgICAgIHJhdGVMaW1pdDogMjAwMCxcbiAgICAgIGVuYWJsZVNRTGlQcm90ZWN0aW9uOiB0cnVlLFxuICAgICAgZW5hYmxlWFNTUHJvdGVjdGlvbjogdHJ1ZSxcbiAgICAgIGVuYWJsZUtub3duQmFkSW5wdXRzOiB0cnVlLFxuICAgIH07XG5cbiAgICBjb25zdCB2cGNFbmRwb2ludENvbmZpZzogQXBwVGhlb3J5VnBjRW5kcG9pbnRDb25maWcgPSBwcm9wcy52cGNFbmRwb2ludENvbmZpZyA/PyB7XG4gICAgICBlbmFibGVTZWNyZXRzTWFuYWdlcjogdHJ1ZSxcbiAgICAgIGVuYWJsZUNsb3VkV2F0Y2hMb2dzOiB0cnVlLFxuICAgICAgZW5hYmxlWFJheTogdHJ1ZSxcbiAgICAgIGVuYWJsZUttczogZmFsc2UsXG4gICAgICBlbmFibGVDbG91ZFdhdGNoTW9uaXRvcmluZzogZmFsc2UsXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcbiAgICB9O1xuXG4gICAgdGhpcy5zZWN1cml0eUdyb3VwID0gdGhpcy5jcmVhdGVTZWN1cml0eUdyb3VwKHtcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgaW5ncmVzc1J1bGVzOiBwcm9wcy5pbmdyZXNzUnVsZXMgPz8gW10sXG4gICAgICBlZ3Jlc3NSdWxlczogcHJvcHMuZWdyZXNzUnVsZXMgPz8gW10sXG4gICAgfSk7XG5cbiAgICBpZiAoZW5hYmxlV2FmKSB7XG4gICAgICBjb25zdCBidWlsZGVyID0gbmV3IFdhZkJ1aWxkZXIodGhpcywgd2FmQ29uZmlnLCB0aGlzLmFwcGxpY2F0aW9uTmFtZSwgdGhpcy5lbnZpcm9ubWVudCk7XG4gICAgICB0aGlzLndhZiA9IGJ1aWxkZXIuYnVpbGQoKTtcbiAgICB9XG5cbiAgICB0aGlzLmNyZWF0ZVNlY3JldHMocHJvcHMuc2VjcmV0cyA/PyBbXSwgdGhpcy5hcHBsaWNhdGlvbk5hbWUsIHRoaXMuZW52aXJvbm1lbnQpO1xuICAgIHRoaXMuY3JlYXRlVnBjRW5kcG9pbnRzKHByb3BzLnZwYywgdnBjRW5kcG9pbnRDb25maWcpO1xuXG4gICAgaWYgKGVuYWJsZVZwY0Zsb3dMb2dzKSB7XG4gICAgICB0aGlzLnZwY0Zsb3dMb2dzR3JvdXAgPSB0aGlzLmVuYWJsZVZwY0Zsb3dMb2dzKHByb3BzLnZwYywgdGhpcy5hcHBsaWNhdGlvbk5hbWUpO1xuICAgIH1cblxuICAgIHRoaXMuY29uZmlndXJlU2VjdXJpdHlNb25pdG9yaW5nKCk7XG4gIH1cblxuICB3YWZXZWJBY2woKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICBpZiAoIXRoaXMud2FmKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJXQUYgaXMgbm90IGVuYWJsZWRcIik7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLndhZjtcbiAgfVxuXG4gIHNlY3VyaXR5R3JvdXBSZXNvdXJjZSgpOiBlYzIuSVNlY3VyaXR5R3JvdXAge1xuICAgIHJldHVybiB0aGlzLnNlY3VyaXR5R3JvdXA7XG4gIH1cblxuICBzZWNyZXQobmFtZTogc3RyaW5nKTogc2VjcmV0c21hbmFnZXIuU2VjcmV0IHtcbiAgICBjb25zdCBzZWNyZXQgPSB0aGlzLnNlY3JldHNbbmFtZV07XG4gICAgaWYgKCFzZWNyZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgdW5rbm93biBzZWNyZXQ6ICR7bmFtZX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlY3JldDtcbiAgfVxuXG4gIHZwY0VuZHBvaW50KG5hbWU6IHN0cmluZyk6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludCB7XG4gICAgY29uc3QgZW5kcG9pbnQgPSB0aGlzLnZwY0VuZHBvaW50c1tuYW1lXTtcbiAgICBpZiAoIWVuZHBvaW50KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gVlBDIGVuZHBvaW50OiAke25hbWV9YCk7XG4gICAgfVxuICAgIHJldHVybiBlbmRwb2ludDtcbiAgfVxuXG4gIHNlY3VyaXR5TWV0cmljKG5hbWU6IHN0cmluZyk6IGNsb3Vkd2F0Y2guSU1ldHJpYyB7XG4gICAgY29uc3QgbWV0cmljID0gdGhpcy5zZWN1cml0eU1ldHJpY3NbbmFtZV07XG4gICAgaWYgKCFtZXRyaWMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgdW5rbm93biBzZWN1cml0eSBtZXRyaWM6ICR7bmFtZX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIG1ldHJpYztcbiAgfVxuXG4gIGFkZEN1c3RvbVNlY3VyaXR5UnVsZShydWxlOiBBcHBUaGVvcnlTZWN1cml0eVJ1bGUsIGRpcmVjdGlvbjogXCJpbmdyZXNzXCIgfCBcImVncmVzc1wiKTogdm9pZCB7XG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gXCJpbmdyZXNzXCIpIHtcbiAgICAgIHRoaXMuc2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShcbiAgICAgICAgcnVsZS5zb3VyY2UsXG4gICAgICAgIHBvcnRGb3JSdWxlKHJ1bGUucG9ydCwgcnVsZS5wcm90b2NvbCksXG4gICAgICAgIHJ1bGUuZGVzY3JpcHRpb24sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIHRoaXMuY3JlYXRlU2VjdXJpdHlSdWxlTWV0cmljKFwiaW5ncmVzc19jdXN0b21cIiwgcnVsZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5zZWN1cml0eUdyb3VwLmFkZEVncmVzc1J1bGUocnVsZS5zb3VyY2UsIHBvcnRGb3JSdWxlKHJ1bGUucG9ydCwgcnVsZS5wcm90b2NvbCksIHJ1bGUuZGVzY3JpcHRpb24sIGZhbHNlKTtcbiAgICB0aGlzLmNyZWF0ZVNlY3VyaXR5UnVsZU1ldHJpYyhcImVncmVzc19jdXN0b21cIiwgcnVsZSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3VyaXR5R3JvdXAoYXJnczoge1xuICAgIHZwYzogZWMyLklWcGM7XG4gICAgaW5ncmVzc1J1bGVzOiBBcHBUaGVvcnlTZWN1cml0eVJ1bGVbXTtcbiAgICBlZ3Jlc3NSdWxlczogQXBwVGhlb3J5U2VjdXJpdHlSdWxlW107XG4gIH0pOiBlYzIuU2VjdXJpdHlHcm91cCB7XG4gICAgY29uc3QgZ3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgXCJTZWN1cml0eUdyb3VwXCIsIHtcbiAgICAgIHZwYzogYXJncy52cGMsXG4gICAgICBkZXNjcmlwdGlvbjogYFNlY3VyaXR5IGdyb3VwIGZvciAke3RoaXMuYXBwbGljYXRpb25OYW1lfWAsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBmYWxzZSxcbiAgICAgIGRpc2FibGVJbmxpbmVSdWxlczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5pbmdyZXNzUnVsZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHJ1bGUgPSBhcmdzLmluZ3Jlc3NSdWxlc1tpXTtcbiAgICAgIGdyb3VwLmFkZEluZ3Jlc3NSdWxlKHJ1bGUuc291cmNlLCBwb3J0Rm9yUnVsZShydWxlLnBvcnQsIHJ1bGUucHJvdG9jb2wpLCBydWxlLmRlc2NyaXB0aW9uLCBmYWxzZSk7XG4gICAgICB0aGlzLmNyZWF0ZVNlY3VyaXR5UnVsZU1ldHJpYyhgSW5ncmVzc1J1bGUke2l9YCwgcnVsZSk7XG4gICAgfVxuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmVncmVzc1J1bGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBydWxlID0gYXJncy5lZ3Jlc3NSdWxlc1tpXTtcbiAgICAgIGdyb3VwLmFkZEVncmVzc1J1bGUocnVsZS5zb3VyY2UsIHBvcnRGb3JSdWxlKHJ1bGUucG9ydCwgcnVsZS5wcm90b2NvbCksIHJ1bGUuZGVzY3JpcHRpb24sIGZhbHNlKTtcbiAgICAgIHRoaXMuY3JlYXRlU2VjdXJpdHlSdWxlTWV0cmljKGBFZ3Jlc3NSdWxlJHtpfWAsIHJ1bGUpO1xuICAgIH1cblxuICAgIGdyb3VwLmFkZEVncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoNDQzKSwgXCJBbGxvdyBIVFRQUyB0byBBV1Mgc2VydmljZXNcIiwgZmFsc2UpO1xuICAgIGdyb3VwLmFkZEVncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC51ZHAoNTMpLCBcIkFsbG93IEROUyByZXNvbHV0aW9uXCIsIGZhbHNlKTtcblxuICAgIFRhZ3Mub2YoZ3JvdXApLmFkZChcIkVudmlyb25tZW50XCIsIHRoaXMuZW52aXJvbm1lbnQpO1xuICAgIFRhZ3Mub2YoZ3JvdXApLmFkZChcIkFwcGxpY2F0aW9uXCIsIHRoaXMuYXBwbGljYXRpb25OYW1lKTtcbiAgICBUYWdzLm9mKGdyb3VwKS5hZGQoXCJTZWN1cml0eUxldmVsXCIsIFwiRW5oYW5jZWRcIik7XG5cbiAgICByZXR1cm4gZ3JvdXA7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlY3VyaXR5UnVsZU1ldHJpYyhydWxlSWQ6IHN0cmluZywgcnVsZTogQXBwVGhlb3J5U2VjdXJpdHlSdWxlKTogdm9pZCB7XG4gICAgY29uc3QgbWV0cmljTmFtZSA9IGBUcmFmZmljXyR7cnVsZUlkfWA7XG4gICAgdGhpcy5zZWN1cml0eU1ldHJpY3NbbWV0cmljTmFtZV0gPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiBcIlNlY3VyaXR5L05ldHdvcmtSdWxlc1wiLFxuICAgICAgbWV0cmljTmFtZSxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgUnVsZUlkOiBydWxlSWQsXG4gICAgICAgIFBvcnQ6IFN0cmluZyhNYXRoLnRydW5jKHJ1bGUucG9ydCkpLFxuICAgICAgICBQcm90b2NvbDogU3RyaW5nKHJ1bGUucHJvdG9jb2wpLFxuICAgICAgfSxcbiAgICAgIHN0YXRpc3RpYzogXCJTdW1cIixcbiAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2VjcmV0cyhjb25maWdzOiBBcHBUaGVvcnlTZWNyZXRDb25maWdbXSwgYXBwbGljYXRpb25OYW1lOiBzdHJpbmcsIGVudmlyb25tZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGNvbmZpZyBvZiBjb25maWdzKSB7XG4gICAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsIGNvbmZpZy5uYW1lLCB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiBjb25maWcuZGVzY3JpcHRpb24sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgICAuLi4oY29uZmlnLnRlbXBsYXRlXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgICAgICAgICAgc2VjcmV0U3RyaW5nVGVtcGxhdGU6IGNvbmZpZy50ZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICBnZW5lcmF0ZVN0cmluZ0tleTogY29uZmlnLmdlbmVyYXRlS2V5ID8/IFwicGFzc3dvcmRcIixcbiAgICAgICAgICAgICAgICBleGNsdWRlQ2hhcmFjdGVyczogY29uZmlnLmV4Y2x1ZGVDaGFycyA/PyBcIlwiLFxuICAgICAgICAgICAgICAgIHBhc3N3b3JkTGVuZ3RoOiBjb25maWcubGVuZ3RoID8/IDMyLFxuICAgICAgICAgICAgICAgIGV4Y2x1ZGVQdW5jdHVhdGlvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgICBleGNsdWRlTnVtYmVyczogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXhjbHVkZUxvd2VyY2FzZTogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXhjbHVkZVVwcGVyY2FzZTogZmFsc2UsXG4gICAgICAgICAgICAgICAgcmVxdWlyZUVhY2hJbmNsdWRlZFR5cGU6IHRydWUsXG4gICAgICAgICAgICAgIH0gYXMgc2VjcmV0c21hbmFnZXIuU2VjcmV0U3RyaW5nR2VuZXJhdG9yLFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChjb25maWcuZW5hYmxlUm90YXRpb24pIHtcbiAgICAgICAgY29uc3Qgcm90YXRpb25TY2hlZHVsZTogc2VjcmV0c21hbmFnZXIuUm90YXRpb25TY2hlZHVsZU9wdGlvbnMgPSB7XG4gICAgICAgICAgLi4uKGNvbmZpZy5yb3RhdGlvblNjaGVkdWxlID8/IHsgYXV0b21hdGljYWxseUFmdGVyOiBEdXJhdGlvbi5kYXlzKDMwKSB9KSxcbiAgICAgICAgICAuLi4oY29uZmlnLnJvdGF0aW9uTGFtYmRhID8geyByb3RhdGlvbkxhbWJkYTogY29uZmlnLnJvdGF0aW9uTGFtYmRhIH0gOiB7fSksXG4gICAgICAgIH07XG4gICAgICAgIHNlY3JldC5hZGRSb3RhdGlvblNjaGVkdWxlKGAke2NvbmZpZy5uYW1lfVJvdGF0aW9uYCwgcm90YXRpb25TY2hlZHVsZSk7XG4gICAgICB9XG5cbiAgICAgIFRhZ3Mub2Yoc2VjcmV0KS5hZGQoXCJFbnZpcm9ubWVudFwiLCBlbnZpcm9ubWVudCk7XG4gICAgICBUYWdzLm9mKHNlY3JldCkuYWRkKFwiQXBwbGljYXRpb25cIiwgYXBwbGljYXRpb25OYW1lKTtcbiAgICAgIFRhZ3Mub2Yoc2VjcmV0KS5hZGQoXCJEYXRhQ2xhc3NpZmljYXRpb25cIiwgXCJDb25maWRlbnRpYWxcIik7XG5cbiAgICAgIHRoaXMuc2VjcmV0c1tjb25maWcubmFtZV0gPSBzZWNyZXQ7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVWcGNFbmRwb2ludHModnBjOiBlYzIuSVZwYywgY29uZmlnOiBBcHBUaGVvcnlWcGNFbmRwb2ludENvbmZpZyk6IHZvaWQge1xuICAgIGNvbnN0IHByaXZhdGVEbnNFbmFibGVkID0gY29uZmlnLnByaXZhdGVEbnNFbmFibGVkID8/IHRydWU7XG5cbiAgICBjb25zdCBtayA9IChuYW1lOiBzdHJpbmcsIHNlcnZpY2U6IGVjMi5JSW50ZXJmYWNlVnBjRW5kcG9pbnRTZXJ2aWNlKTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50ID0+XG4gICAgICBuZXcgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50KHRoaXMsIGAke25hbWV9RW5kcG9pbnRgLCB7XG4gICAgICAgIHZwYyxcbiAgICAgICAgc2VydmljZSxcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IFt0aGlzLnNlY3VyaXR5R3JvdXBdLFxuICAgICAgICBwcml2YXRlRG5zRW5hYmxlZCxcbiAgICAgICAgc3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgICB9KTtcblxuICAgIGlmIChjb25maWcuZW5hYmxlU2VjcmV0c01hbmFnZXIpIHtcbiAgICAgIHRoaXMudnBjRW5kcG9pbnRzW1wiU2VjcmV0c01hbmFnZXJcIl0gPSBtayhcIlNlY3JldHNNYW5hZ2VyXCIsIGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuU0VDUkVUU19NQU5BR0VSKTtcbiAgICB9XG4gICAgaWYgKGNvbmZpZy5lbmFibGVDbG91ZFdhdGNoTG9ncykge1xuICAgICAgdGhpcy52cGNFbmRwb2ludHNbXCJDbG91ZFdhdGNoTG9nc1wiXSA9IG1rKFwiQ2xvdWRXYXRjaExvZ3NcIiwgZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5DTE9VRFdBVENIX0xPR1MpO1xuICAgIH1cbiAgICBpZiAoY29uZmlnLmVuYWJsZVhSYXkpIHtcbiAgICAgIHRoaXMudnBjRW5kcG9pbnRzW1wiWFJheVwiXSA9IG1rKFwiWFJheVwiLCBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLlhSQVkpO1xuICAgIH1cbiAgICBpZiAoY29uZmlnLmVuYWJsZUttcykge1xuICAgICAgdGhpcy52cGNFbmRwb2ludHNbXCJLTVNcIl0gPSBtayhcIktNU1wiLCBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLktNUyk7XG4gICAgfVxuICAgIGlmIChjb25maWcuZW5hYmxlQ2xvdWRXYXRjaE1vbml0b3JpbmcpIHtcbiAgICAgIHRoaXMudnBjRW5kcG9pbnRzW1wiQ2xvdWRXYXRjaE1vbml0b3JpbmdcIl0gPSBtayhcbiAgICAgICAgXCJDbG91ZFdhdGNoTW9uaXRvcmluZ1wiLFxuICAgICAgICBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLkNMT1VEV0FUQ0hfTU9OSVRPUklORyxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBlbmFibGVWcGNGbG93TG9ncyh2cGM6IGVjMi5JVnBjLCBhcHBsaWNhdGlvbk5hbWU6IHN0cmluZyk6IGxvZ3MuTG9nR3JvdXAge1xuICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJWUENGbG93TG9nc0dyb3VwXCIsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9hd3MvdnBjL2Zsb3dsb2dzLyR7YXBwbGljYXRpb25OYW1lfWAsXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJWUENGbG93TG9nc1JvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJ2cGMtZmxvdy1sb2dzLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBGbG93TG9nc0RlbGl2ZXJ5Um9sZVBvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBhY3Rpb25zOiBbXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCIsIFwibG9nczpEZXNjcmliZUxvZ0dyb3Vwc1wiLCBcImxvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zXCJdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cC5sb2dHcm91cEFybl0sXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICBdLFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBuZXcgZWMyLkZsb3dMb2codGhpcywgXCJWUENGbG93TG9nc1wiLCB7XG4gICAgICByZXNvdXJjZVR5cGU6IGVjMi5GbG93TG9nUmVzb3VyY2VUeXBlLmZyb21WcGModnBjKSxcbiAgICAgIGRlc3RpbmF0aW9uOiBlYzIuRmxvd0xvZ0Rlc3RpbmF0aW9uLnRvQ2xvdWRXYXRjaExvZ3MobG9nR3JvdXAsIHJvbGUpLFxuICAgICAgdHJhZmZpY1R5cGU6IGVjMi5GbG93TG9nVHJhZmZpY1R5cGUuQUxMLFxuICAgICAgbWF4QWdncmVnYXRpb25JbnRlcnZhbDogZWMyLkZsb3dMb2dNYXhBZ2dyZWdhdGlvbkludGVydmFsLk9ORV9NSU5VVEUsXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbG9nR3JvdXA7XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZVNlY3VyaXR5TW9uaXRvcmluZygpOiB2b2lkIHtcbiAgICB0aGlzLnNlY3VyaXR5TWV0cmljc1tcIldBRkJsb2NrZWRSZXF1ZXN0c1wiXSA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6IFwiQVdTL1dBRlYyXCIsXG4gICAgICBtZXRyaWNOYW1lOiBcIkJsb2NrZWRSZXF1ZXN0c1wiLFxuICAgICAgZGltZW5zaW9uc01hcDoge1xuICAgICAgICBXZWJBQ0w6IGAke3RoaXMuYXBwbGljYXRpb25OYW1lfVdBRmAsXG4gICAgICAgIFJlZ2lvbjogU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgfSxcbiAgICAgIHN0YXRpc3RpYzogXCJTdW1cIixcbiAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICB9KTtcblxuICAgIHRoaXMuc2VjdXJpdHlNZXRyaWNzW1wiU2VjdXJpdHlHcm91cENoYW5nZXNcIl0gPSBuZXcgY2xvdWR3YXRjaC5NZXRyaWMoe1xuICAgICAgbmFtZXNwYWNlOiBcIkFXUy9FdmVudHNcIixcbiAgICAgIG1ldHJpY05hbWU6IFwiU2VjdXJpdHlHcm91cENoYW5nZXNcIixcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgQXBwbGljYXRpb246IHRoaXMuYXBwbGljYXRpb25OYW1lLFxuICAgICAgICBFbnZpcm9ubWVudDogdGhpcy5lbnZpcm9ubWVudCxcbiAgICAgIH0sXG4gICAgICBzdGF0aXN0aWM6IFwiU3VtXCIsXG4gICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy52cGNGbG93TG9nc0dyb3VwKSB7XG4gICAgICBuZXcgbG9ncy5NZXRyaWNGaWx0ZXIodGhpcywgXCJSZWplY3RlZENvbm5lY3Rpb25zRmlsdGVyXCIsIHtcbiAgICAgICAgbG9nR3JvdXA6IHRoaXMudnBjRmxvd0xvZ3NHcm91cCxcbiAgICAgICAgbWV0cmljTmFtZXNwYWNlOiBcIlNlY3VyaXR5L1ZQQ1wiLFxuICAgICAgICBtZXRyaWNOYW1lOiBcIlJlamVjdGVkQ29ubmVjdGlvbnNcIixcbiAgICAgICAgZmlsdGVyUGF0dGVybjogbG9ncy5GaWx0ZXJQYXR0ZXJuLnNwYWNlRGVsaW1pdGVkKFxuICAgICAgICAgIFwidmVyc2lvblwiLFxuICAgICAgICAgIFwiYWNjb3VudFwiLFxuICAgICAgICAgIFwiZW5pXCIsXG4gICAgICAgICAgXCJzb3VyY2VcIixcbiAgICAgICAgICBcImRlc3RpbmF0aW9uXCIsXG4gICAgICAgICAgXCJzcmNwb3J0XCIsXG4gICAgICAgICAgXCJkZXN0cG9ydFwiLFxuICAgICAgICAgIFwicHJvdG9jb2xcIixcbiAgICAgICAgICBcInBhY2tldHNcIixcbiAgICAgICAgICBcImJ5dGVzXCIsXG4gICAgICAgICAgXCJ3aW5kb3dzdGFydFwiLFxuICAgICAgICAgIFwid2luZG93ZW5kXCIsXG4gICAgICAgICAgXCJhY3Rpb25cIixcbiAgICAgICAgICBcImZsb3dsb2dzdGF0dXNcIixcbiAgICAgICAgKS53aGVyZVN0cmluZyhcImFjdGlvblwiLCBcIj1cIiwgXCJSRUpFQ1RcIiksXG4gICAgICAgIG1ldHJpY1ZhbHVlOiBcIjFcIixcbiAgICAgICAgZGVmYXVsdFZhbHVlOiAwLFxuICAgICAgfSk7XG5cbiAgICAgIG5ldyBsb2dzLk1ldHJpY0ZpbHRlcih0aGlzLCBcIlN1c3BpY2lvdXNQb3J0c0ZpbHRlclwiLCB7XG4gICAgICAgIGxvZ0dyb3VwOiB0aGlzLnZwY0Zsb3dMb2dzR3JvdXAsXG4gICAgICAgIG1ldHJpY05hbWVzcGFjZTogXCJTZWN1cml0eS9WUENcIixcbiAgICAgICAgbWV0cmljTmFtZTogXCJTdXNwaWNpb3VzUG9ydEFjdGl2aXR5XCIsXG4gICAgICAgIGZpbHRlclBhdHRlcm46IGxvZ3MuRmlsdGVyUGF0dGVybi5hbnlUZXJtKFwiZGVzdHBvcnQ9MjJcIiwgXCJkZXN0cG9ydD0yM1wiLCBcImRlc3Rwb3J0PTMzODlcIiksXG4gICAgICAgIG1ldHJpY1ZhbHVlOiBcIjFcIixcbiAgICAgICAgZGVmYXVsdFZhbHVlOiAwLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHBvcnRGb3JSdWxlKHBvcnQ6IG51bWJlciwgcHJvdG9jb2w6IGVjMi5Qcm90b2NvbCk6IGVjMi5Qb3J0IHtcbiAgc3dpdGNoIChwcm90b2NvbCkge1xuICAgIGNhc2UgZWMyLlByb3RvY29sLlRDUDpcbiAgICAgIHJldHVybiBlYzIuUG9ydC50Y3AocG9ydCk7XG4gICAgY2FzZSBlYzIuUHJvdG9jb2wuVURQOlxuICAgICAgcmV0dXJuIGVjMi5Qb3J0LnVkcChwb3J0KTtcbiAgICBjYXNlIGVjMi5Qcm90b2NvbC5BTEw6XG4gICAgICByZXR1cm4gZWMyLlBvcnQuYWxsVHJhZmZpYygpO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gZWMyLlBvcnQudGNwKHBvcnQpO1xuICB9XG59XG5cbmNsYXNzIFdhZkJ1aWxkZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IHJ1bGVzOiB3YWZ2Mi5DZm5XZWJBQ0wuUnVsZVByb3BlcnR5W10gPSBbXTtcbiAgcHJpdmF0ZSBwcmlvcml0eSA9IDE7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzY29wZTogQ29uc3RydWN0LFxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29uZmlnOiBBcHBUaGVvcnlXYWZSdWxlQ29uZmlnLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYXBwbGljYXRpb25OYW1lOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSBlbnZpcm9ubWVudDogc3RyaW5nLFxuICApIHt9XG5cbiAgYnVpbGQoKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICB0aGlzLmFkZFJhdGVMaW1pdFJ1bGUoKTtcbiAgICB0aGlzLmFkZE1hbmFnZWRSdWxlcygpO1xuICAgIHRoaXMuYWRkSXBSdWxlcygpO1xuICAgIHRoaXMuYWRkR2VvQmxvY2tpbmdSdWxlKCk7XG4gICAgcmV0dXJuIHRoaXMuY3JlYXRlV2ViQWNsKCk7XG4gIH1cblxuICBwcml2YXRlIGFkZFJhdGVMaW1pdFJ1bGUoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy5lbmFibGVSYXRlTGltaXQpIHJldHVybjtcblxuICAgIGNvbnN0IGxpbWl0ID0gdGhpcy5jb25maWcucmF0ZUxpbWl0ID8/IDIwMDA7XG4gICAgdGhpcy5ydWxlcy5wdXNoKHtcbiAgICAgIG5hbWU6IFwiUmF0ZUxpbWl0UnVsZVwiLFxuICAgICAgcHJpb3JpdHk6IHRoaXMucHJpb3JpdHkrKyxcbiAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICByYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICBsaW1pdCxcbiAgICAgICAgICBhZ2dyZWdhdGVLZXlUeXBlOiBcIklQXCIsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgYWN0aW9uOiB7XG4gICAgICAgIGJsb2NrOiB7XG4gICAgICAgICAgY3VzdG9tUmVzcG9uc2U6IHtcbiAgICAgICAgICAgIHJlc3BvbnNlQ29kZTogNDI5LFxuICAgICAgICAgICAgY3VzdG9tUmVzcG9uc2VCb2R5S2V5OiBcIlJhdGVMaW1pdEV4Y2VlZGVkXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB2aXNpYmlsaXR5Q29uZmlnKFwiUmF0ZUxpbWl0UnVsZVwiKSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkTWFuYWdlZFJ1bGVzKCk6IHZvaWQge1xuICAgIGNvbnN0IG1hbmFnZWQgPSBbXG4gICAgICB7IGVuYWJsZWQ6IHRoaXMuY29uZmlnLmVuYWJsZVNRTGlQcm90ZWN0aW9uLCBuYW1lOiBcIlNRTGlQcm90ZWN0aW9uXCIsIHJ1bGVTZXQ6IFwiQVdTTWFuYWdlZFJ1bGVzU1FMaVJ1bGVTZXRcIiB9LFxuICAgICAgeyBlbmFibGVkOiB0aGlzLmNvbmZpZy5lbmFibGVYU1NQcm90ZWN0aW9uLCBuYW1lOiBcIlhTU1Byb3RlY3Rpb25cIiwgcnVsZVNldDogXCJBV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0XCIgfSxcbiAgICAgIHsgZW5hYmxlZDogdGhpcy5jb25maWcuZW5hYmxlS25vd25CYWRJbnB1dHMsIG5hbWU6IFwiS25vd25CYWRJbnB1dHNcIiwgcnVsZVNldDogXCJBV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXRcIiB9LFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IHJ1bGUgb2YgbWFuYWdlZCkge1xuICAgICAgaWYgKCFydWxlLmVuYWJsZWQpIGNvbnRpbnVlO1xuICAgICAgdGhpcy5ydWxlcy5wdXNoKG1hbmFnZWRXYWZSdWxlKHJ1bGUubmFtZSwgcnVsZS5ydWxlU2V0LCB0aGlzLnByaW9yaXR5KyspKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkZElwUnVsZXMoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuY29uZmlnLmlwV2hpdGVsaXN0ICYmIHRoaXMuY29uZmlnLmlwV2hpdGVsaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMucnVsZXMucHVzaCh0aGlzLmNyZWF0ZUlwUnVsZShcIklQV2hpdGVsaXN0XCIsIFwiV2hpdGVsaXN0XCIsIHRoaXMuY29uZmlnLmlwV2hpdGVsaXN0LCB0cnVlKSk7XG4gICAgICB0aGlzLnByaW9yaXR5Kys7XG4gICAgfVxuICAgIGlmICh0aGlzLmNvbmZpZy5pcEJsYWNrbGlzdCAmJiB0aGlzLmNvbmZpZy5pcEJsYWNrbGlzdC5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnJ1bGVzLnB1c2godGhpcy5jcmVhdGVJcFJ1bGUoXCJJUEJsYWNrbGlzdFwiLCBcIkJsYWNrbGlzdFwiLCB0aGlzLmNvbmZpZy5pcEJsYWNrbGlzdCwgZmFsc2UpKTtcbiAgICAgIHRoaXMucHJpb3JpdHkrKztcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUlwUnVsZShuYW1lOiBzdHJpbmcsIGlwU2V0TmFtZTogc3RyaW5nLCBpcHM6IHN0cmluZ1tdLCBhbGxvdzogYm9vbGVhbik6IHdhZnYyLkNmbldlYkFDTC5SdWxlUHJvcGVydHkge1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lLFxuICAgICAgcHJpb3JpdHk6IHRoaXMucHJpb3JpdHksXG4gICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgaXBTZXRSZWZlcmVuY2VTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICBhcm46IHRoaXMuY3JlYXRlSXBTZXQoaXBTZXROYW1lLCBpcHMpLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIC4uLihhbGxvd1xuICAgICAgICA/IHsgYWN0aW9uOiB7IGFsbG93OiB7fSB9IH1cbiAgICAgICAgOiB7IGFjdGlvbjogeyBibG9jazoge30gfSB9KSxcbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHZpc2liaWxpdHlDb25maWcobmFtZSksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgYWRkR2VvQmxvY2tpbmdSdWxlKCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5jb25maWcuZ2VvQmxvY2tpbmcgfHwgdGhpcy5jb25maWcuZ2VvQmxvY2tpbmcubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICB0aGlzLnJ1bGVzLnB1c2goe1xuICAgICAgbmFtZTogXCJHZW9CbG9ja2luZ1wiLFxuICAgICAgcHJpb3JpdHk6IHRoaXMucHJpb3JpdHkrKyxcbiAgICAgIHN0YXRlbWVudDoge1xuICAgICAgICBnZW9NYXRjaFN0YXRlbWVudDoge1xuICAgICAgICAgIGNvdW50cnlDb2RlczogdGhpcy5jb25maWcuZ2VvQmxvY2tpbmcsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgYWN0aW9uOiB7IGJsb2NrOiB7fSB9LFxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzogdmlzaWJpbGl0eUNvbmZpZyhcIkdlb0Jsb2NraW5nXCIpLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVXZWJBY2woKTogd2FmdjIuQ2ZuV2ViQUNMIHtcbiAgICByZXR1cm4gbmV3IHdhZnYyLkNmbldlYkFDTCh0aGlzLnNjb3BlLCBcIldlYkFDTFwiLCB7XG4gICAgICBzY29wZTogXCJSRUdJT05BTFwiLFxuICAgICAgZGVmYXVsdEFjdGlvbjogeyBhbGxvdzoge30gfSxcbiAgICAgIHJ1bGVzOiB0aGlzLnJ1bGVzLFxuICAgICAgY3VzdG9tUmVzcG9uc2VCb2RpZXM6IHtcbiAgICAgICAgUmF0ZUxpbWl0RXhjZWVkZWQ6IHtcbiAgICAgICAgICBjb250ZW50VHlwZTogXCJBUFBMSUNBVElPTl9KU09OXCIsXG4gICAgICAgICAgY29udGVudDogYHtcImVycm9yXCI6IFwicmF0ZV9saW1pdF9leGNlZWRlZFwiLCBcIm1lc3NhZ2VcIjogXCJUb28gbWFueSByZXF1ZXN0c1wiLCBcInJldHJ5X2FmdGVyXCI6IDYwfWAsXG4gICAgICAgIH0sXG4gICAgICAgIEFjY2Vzc0RlbmllZDoge1xuICAgICAgICAgIGNvbnRlbnRUeXBlOiBcIkFQUExJQ0FUSU9OX0pTT05cIixcbiAgICAgICAgICBjb250ZW50OiBge1wiZXJyb3JcIjogXCJhY2Nlc3NfZGVuaWVkXCIsIFwibWVzc2FnZVwiOiBcIkFjY2VzcyBkZW5pZWQgYnkgc2VjdXJpdHkgcG9saWN5XCJ9YCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbWV0cmljTmFtZTogYCR7dGhpcy5hcHBsaWNhdGlvbk5hbWV9V0FGYCxcbiAgICAgIH0sXG4gICAgICB0YWdzOiBbXG4gICAgICAgIHsga2V5OiBcIkVudmlyb25tZW50XCIsIHZhbHVlOiB0aGlzLmVudmlyb25tZW50IH0sXG4gICAgICAgIHsga2V5OiBcIkFwcGxpY2F0aW9uXCIsIHZhbHVlOiB0aGlzLmFwcGxpY2F0aW9uTmFtZSB9LFxuICAgICAgXSBhcyBDZm5UYWdbXSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlSXBTZXQobmFtZTogc3RyaW5nLCBpcHM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBjb25zdCBpcFNldCA9IG5ldyB3YWZ2Mi5DZm5JUFNldCh0aGlzLnNjb3BlLCBgSVBTZXQke25hbWV9YCwge1xuICAgICAgc2NvcGU6IFwiUkVHSU9OQUxcIixcbiAgICAgIGlwQWRkcmVzc1ZlcnNpb246IFwiSVBWNFwiLFxuICAgICAgYWRkcmVzc2VzOiBpcHMsXG4gICAgICB0YWdzOiBbeyBrZXk6IFwiTmFtZVwiLCB2YWx1ZTogbmFtZSB9XSBhcyBDZm5UYWdbXSxcbiAgICB9KTtcbiAgICByZXR1cm4gaXBTZXQuYXR0ckFybjtcbiAgfVxufVxuXG5mdW5jdGlvbiB2aXNpYmlsaXR5Q29uZmlnKG1ldHJpY05hbWU6IHN0cmluZyk6IHdhZnYyLkNmbldlYkFDTC5WaXNpYmlsaXR5Q29uZmlnUHJvcGVydHkge1xuICByZXR1cm4ge1xuICAgIHNhbXBsZWRSZXF1ZXN0c0VuYWJsZWQ6IHRydWUsXG4gICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgIG1ldHJpY05hbWUsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1hbmFnZWRXYWZSdWxlKG5hbWU6IHN0cmluZywgcnVsZVNldDogc3RyaW5nLCBwcmlvcml0eTogbnVtYmVyKTogd2FmdjIuQ2ZuV2ViQUNMLlJ1bGVQcm9wZXJ0eSB7XG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBwcmlvcml0eSxcbiAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgdmVuZG9yTmFtZTogXCJBV1NcIixcbiAgICAgICAgbmFtZTogcnVsZVNldCxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvdmVycmlkZUFjdGlvbjogeyBub25lOiB7fSB9LFxuICAgIHZpc2liaWxpdHlDb25maWc6IHZpc2liaWxpdHlDb25maWcobmFtZSksXG4gIH07XG59XG4iXX0=