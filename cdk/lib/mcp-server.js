"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpServer = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigwv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const logs = require("aws-cdk-lib/aws-logs");
const route53 = require("aws-cdk-lib/aws-route53");
const constructs_1 = require("constructs");
/**
 * An MCP (Model Context Protocol) server construct that provisions an HTTP API Gateway v2
 * with a Lambda integration on POST /mcp, optional DynamoDB session table, and optional
 * custom domain with Route53.
 *
 * @example
 * const server = new AppTheoryMcpServer(this, 'McpServer', {
 *   handler: mcpFn,
 *   enableSessionTable: true,
 *   sessionTtlMinutes: 120,
 * });
 */
class AppTheoryMcpServer extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "$default";
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        // Create HTTP API with default stage
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName,
            createDefaultStage: !needsExplicitStage,
        });
        // If custom stage options, create the stage explicitly
        let stage;
        if (needsExplicitStage) {
            stage = new apigwv2.HttpStage(this, "Stage", {
                httpApi: this.api,
                stageName,
                autoDeploy: true,
                throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
                    ? {
                        rateLimit: stageOpts.throttlingRateLimit,
                        burstLimit: stageOpts.throttlingBurstLimit,
                    }
                    : undefined,
            });
            // Set up access logging if enabled
            if (stageOpts.accessLogging) {
                const logGroup = new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
                this.accessLogGroup = logGroup;
                const cfnStage = stage.node.defaultChild;
                cfnStage.accessLogSettings = {
                    destinationArn: logGroup.logGroupArn,
                    format: JSON.stringify({
                        requestId: "$context.requestId",
                        ip: "$context.identity.sourceIp",
                        requestTime: "$context.requestTime",
                        httpMethod: "$context.httpMethod",
                        routeKey: "$context.routeKey",
                        status: "$context.status",
                        protocol: "$context.protocol",
                        responseLength: "$context.responseLength",
                        integrationLatency: "$context.integrationLatency",
                    }),
                };
            }
        }
        else {
            stage = this.api.defaultStage;
        }
        // Add POST /mcp route with Lambda integration
        this.api.addRoutes({
            path: "/mcp",
            methods: [apigwv2.HttpMethod.POST],
            integration: new apigwv2Integrations.HttpLambdaIntegration("McpHandler", props.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            }),
        });
        // Optional session table
        if (props.enableSessionTable) {
            const table = new dynamodb.Table(this, "SessionTable", {
                tableName: props.sessionTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "expiresAt",
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
                pointInTimeRecovery: true,
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            table.grantReadWriteData(props.handler);
            this.sessionTable = table;
        }
        if (this.sessionTable) {
            this.addEnvironment(props.handler, "MCP_SESSION_TABLE", this.sessionTable.tableName);
            this.addEnvironment(props.handler, "MCP_SESSION_TTL_MINUTES", String(props.sessionTtlMinutes ?? 60));
        }
        // Optional custom domain
        if (props.domain) {
            if (!stage) {
                throw new Error("AppTheoryMcpServer: no stage available for domain mapping");
            }
            this.setupCustomDomain(props.domain, stage);
            this.endpoint = `${stripTrailingSlash(`https://${props.domain.domainName}`)}/mcp`;
        }
        else {
            // Compute execute-api endpoint URL (include stage path unless using $default).
            const baseUrl = (stageName === "$default")
                ? this.api.apiEndpoint
                : `${this.api.apiEndpoint}/${stageName}`;
            this.endpoint = `${stripTrailingSlash(baseUrl)}/mcp`;
        }
        // Inject environment variables into the Lambda handler
        this.addEnvironment(props.handler, "MCP_ENDPOINT", this.endpoint);
    }
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise uses L1 override.
     */
    addEnvironment(handler, key, value) {
        if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
            handler.addEnvironment(key, value);
        }
    }
    /**
     * Set up custom domain with optional Route53 record.
     */
    setupCustomDomain(domainOpts, stage) {
        const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryMcpServer: domain requires either certificate or certificateArn");
        }
        const dmn = new apigwv2.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
        });
        this.domainName = dmn;
        const mapping = new apigwv2.ApiMapping(this, "ApiMapping", {
            api: this.api,
            domainName: dmn,
            stage,
        });
        this.apiMapping = mapping;
        if (domainOpts.hostedZone) {
            const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
            const record = new route53.CnameRecord(this, "CnameRecord", {
                zone: domainOpts.hostedZone,
                recordName,
                domainName: dmn.regionalDomainName,
            });
            this.cnameRecord = record;
        }
    }
}
exports.AppTheoryMcpServer = AppTheoryMcpServer;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMcpServer[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpServer", version: "0.9.1" };
/**
 * Convert a domain name to a Route53 record name relative to the zone.
 */
function toRoute53RecordName(domainName, zone) {
    const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
    const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
    if (!zoneName)
        return fqdn;
    if (fqdn === zoneName)
        return "";
    const suffix = `.${zoneName}`;
    if (fqdn.endsWith(suffix)) {
        return fqdn.slice(0, -suffix.length);
    }
    return fqdn;
}
function stripTrailingSlash(url) {
    return url.replace(/\/$/, "");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXNlcnZlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1zZXJ2ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBNEM7QUFDNUMsMERBQTBEO0FBQzFELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBRXJELDZDQUE2QztBQUM3QyxtREFBbUQ7QUFDbkQsMkNBQXVDO0FBbUh2Qzs7Ozs7Ozs7Ozs7R0FXRztBQUNILE1BQWEsa0JBQW1CLFNBQVEsc0JBQVM7SUFvQy9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBOEI7UUFDdEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNwQyxNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsU0FBUyxJQUFJLFVBQVUsQ0FBQztRQUVwRCxNQUFNLGtCQUFrQixHQUFHLFNBQVMsS0FBSyxVQUFVO2VBQzlDLFNBQVMsQ0FBQyxhQUFhO2VBQ3ZCLFNBQVMsQ0FBQyxtQkFBbUIsS0FBSyxTQUFTO2VBQzNDLFNBQVMsQ0FBQyxvQkFBb0IsS0FBSyxTQUFTLENBQUM7UUFFbEQscUNBQXFDO1FBQ3JDLElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDMUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ3RCLGtCQUFrQixFQUFFLENBQUMsa0JBQWtCO1NBQ3hDLENBQUMsQ0FBQztRQUVILHVEQUF1RDtRQUN2RCxJQUFJLEtBQWlDLENBQUM7UUFDdEMsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO1lBQ3ZCLEtBQUssR0FBRyxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtnQkFDM0MsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHO2dCQUNqQixTQUFTO2dCQUNULFVBQVUsRUFBRSxJQUFJO2dCQUNoQixRQUFRLEVBQUUsQ0FBQyxTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUyxJQUFJLFNBQVMsQ0FBQyxvQkFBb0IsS0FBSyxTQUFTLENBQUM7b0JBQ3JHLENBQUMsQ0FBQzt3QkFDQSxTQUFTLEVBQUUsU0FBUyxDQUFDLG1CQUFtQjt3QkFDeEMsVUFBVSxFQUFFLFNBQVMsQ0FBQyxvQkFBb0I7cUJBQzNDO29CQUNELENBQUMsQ0FBQyxTQUFTO2FBQ2QsQ0FBQyxDQUFDO1lBRUgsbUNBQW1DO1lBQ25DLElBQUksU0FBUyxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUM1QixNQUFNLFFBQVEsR0FBRyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtvQkFDckQsU0FBUyxFQUFFLFNBQVMsQ0FBQyxrQkFBa0IsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7aUJBQ3hFLENBQUMsQ0FBQztnQkFDRixJQUE0QyxDQUFDLGNBQWMsR0FBRyxRQUFRLENBQUM7Z0JBRXhFLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQztnQkFDN0QsUUFBUSxDQUFDLGlCQUFpQixHQUFHO29CQUMzQixjQUFjLEVBQUUsUUFBUSxDQUFDLFdBQVc7b0JBQ3BDLE1BQU0sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO3dCQUNyQixTQUFTLEVBQUUsb0JBQW9CO3dCQUMvQixFQUFFLEVBQUUsNEJBQTRCO3dCQUNoQyxXQUFXLEVBQUUsc0JBQXNCO3dCQUNuQyxVQUFVLEVBQUUscUJBQXFCO3dCQUNqQyxRQUFRLEVBQUUsbUJBQW1CO3dCQUM3QixNQUFNLEVBQUUsaUJBQWlCO3dCQUN6QixRQUFRLEVBQUUsbUJBQW1CO3dCQUM3QixjQUFjLEVBQUUseUJBQXlCO3dCQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7cUJBQ2xELENBQUM7aUJBQ0gsQ0FBQztZQUNKLENBQUM7UUFDSCxDQUFDO2FBQU0sQ0FBQztZQUNOLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQztRQUNoQyxDQUFDO1FBRUQsOENBQThDO1FBQzlDLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQ2pCLElBQUksRUFBRSxNQUFNO1lBQ1osT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7WUFDbEMsV0FBVyxFQUFFLElBQUksbUJBQW1CLENBQUMscUJBQXFCLENBQUMsWUFBWSxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUU7Z0JBQ3RGLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO2FBQy9ELENBQUM7U0FDSCxDQUFDLENBQUM7UUFFSCx5QkFBeUI7UUFDekIsSUFBSSxLQUFLLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztZQUM3QixNQUFNLEtBQUssR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtnQkFDckQsU0FBUyxFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7Z0JBQ2pDLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7Z0JBQ2pELFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO2dCQUN4RSxtQkFBbUIsRUFBRSxXQUFXO2dCQUNoQyxhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO2dCQUNwQyxtQkFBbUIsRUFBRSxJQUFJO2dCQUN6QixVQUFVLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQyxXQUFXO2FBQ2pELENBQUMsQ0FBQztZQUVILEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDeEMsSUFBSSxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUM7UUFDNUIsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3RCLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxJQUFJLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQ3JGLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDdkcsQ0FBQztRQUVELHlCQUF5QjtRQUN6QixJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNqQixJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQywyREFBMkQsQ0FBQyxDQUFDO1lBQy9FLENBQUM7WUFDRCxJQUFJLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsQ0FBQztZQUM1QyxJQUFJLENBQUMsUUFBUSxHQUFHLEdBQUcsa0JBQWtCLENBQUMsV0FBVyxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDLE1BQU0sQ0FBQztRQUNwRixDQUFDO2FBQU0sQ0FBQztZQUNOLCtFQUErRTtZQUMvRSxNQUFNLE9BQU8sR0FBRyxDQUFDLFNBQVMsS0FBSyxVQUFVLENBQUM7Z0JBQ3hDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFdBQVc7Z0JBQ3RCLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsV0FBVyxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQzNDLElBQUksQ0FBQyxRQUFRLEdBQUcsR0FBRyxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDO1FBQ3ZELENBQUM7UUFFRCx1REFBdUQ7UUFDdkQsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsT0FBTyxFQUFFLGNBQWMsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDcEUsQ0FBQztJQUVEOzs7T0FHRztJQUNLLGNBQWMsQ0FBQyxPQUF5QixFQUFFLEdBQVcsRUFBRSxLQUFhO1FBQzFFLElBQUksZ0JBQWdCLElBQUksT0FBTyxJQUFJLE9BQU8sT0FBTyxDQUFDLGNBQWMsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNoRixPQUFPLENBQUMsY0FBYyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNyQyxDQUFDO0lBQ0gsQ0FBQztJQUVEOztPQUVHO0lBQ0ssaUJBQWlCLENBQUMsVUFBMkMsRUFBRSxLQUFxQjtRQUMxRixNQUFNLFdBQVcsR0FBRyxVQUFVLENBQUMsV0FBVyxJQUFJLENBQUMsVUFBVSxDQUFDLGNBQWM7WUFDdEUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFxQjtZQUN6RyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFZixJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDakIsTUFBTSxJQUFJLEtBQUssQ0FBQywwRUFBMEUsQ0FBQyxDQUFDO1FBQzlGLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNyRCxVQUFVLEVBQUUsVUFBVSxDQUFDLFVBQVU7WUFDakMsV0FBVztTQUNaLENBQUMsQ0FBQztRQUNGLElBQTRDLENBQUMsVUFBVSxHQUFHLEdBQUcsQ0FBQztRQUUvRCxNQUFNLE9BQU8sR0FBRyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUN6RCxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDYixVQUFVLEVBQUUsR0FBRztZQUNmLEtBQUs7U0FDTixDQUFDLENBQUM7UUFDRixJQUE0QyxDQUFDLFVBQVUsR0FBRyxPQUFPLENBQUM7UUFFbkUsSUFBSSxVQUFVLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDMUIsTUFBTSxVQUFVLEdBQUcsbUJBQW1CLENBQUMsVUFBVSxDQUFDLFVBQVUsRUFBRSxVQUFVLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDckYsTUFBTSxNQUFNLEdBQUcsSUFBSSxPQUFPLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQzFELElBQUksRUFBRSxVQUFVLENBQUMsVUFBVTtnQkFDM0IsVUFBVTtnQkFDVixVQUFVLEVBQUUsR0FBRyxDQUFDLGtCQUFrQjthQUNuQyxDQUFDLENBQUM7WUFDRixJQUE4QyxDQUFDLFdBQVcsR0FBRyxNQUFNLENBQUM7UUFDdkUsQ0FBQztJQUNILENBQUM7O0FBNUxILGdEQTZMQzs7O0FBRUQ7O0dBRUc7QUFDSCxTQUFTLG1CQUFtQixDQUFDLFVBQWtCLEVBQUUsSUFBeUI7SUFDeEUsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUMxQixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuLyoqXG4gKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNQ1Agc2VydmVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGN1c3RvbSBkb21haW4gbmFtZSAoZS5nLiwgXCJtY3AuZXhhbXBsZS5jb21cIikuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIGF1dG9tYXRpYyBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBJZiBwcm92aWRlZCwgYSBDTkFNRSByZWNvcmQgd2lsbCBiZSBjcmVhdGVkIHBvaW50aW5nIHRvIHRoZSBBUEkgR2F0ZXdheSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gRE5TIHJlY29yZCBjcmVhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1DUCBzZXJ2ZXIgQVBJIEdhdGV3YXkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFByb3BzIGZvciB0aGUgQXBwVGhlb3J5TWNwU2VydmVyIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgTGFtYmRhIGZ1bmN0aW9uIGhhbmRsaW5nIE1DUCByZXF1ZXN0cy5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIER5bmFtb0RCIHRhYmxlIGZvciBzZXNzaW9uIHN0YXRlIHN0b3JhZ2UuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgc2Vzc2lvbiBEeW5hbW9EQiB0YWJsZS5cbiAgICogT25seSB1c2VkIHdoZW4gZW5hYmxlU2Vzc2lvblRhYmxlIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoYXV0by1nZW5lcmF0ZWQpXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUVEwgaW4gbWludXRlcyBmb3Igc2Vzc2lvbiByZWNvcmRzLlxuICAgKiBPbmx5IHVzZWQgd2hlbiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZS5cbiAgICogQGRlZmF1bHQgNjBcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UdGxNaW51dGVzPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gY3VzdG9tIGRvbWFpbilcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeU1jcFNlcnZlckRvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVmYXVsdHMgYXBwbGllZClcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWNwU2VydmVyU3RhZ2VPcHRpb25zO1xufVxuXG4vKipcbiAqIEFuIE1DUCAoTW9kZWwgQ29udGV4dCBQcm90b2NvbCkgc2VydmVyIGNvbnN0cnVjdCB0aGF0IHByb3Zpc2lvbnMgYW4gSFRUUCBBUEkgR2F0ZXdheSB2MlxuICogd2l0aCBhIExhbWJkYSBpbnRlZ3JhdGlvbiBvbiBQT1NUIC9tY3AsIG9wdGlvbmFsIER5bmFtb0RCIHNlc3Npb24gdGFibGUsIGFuZCBvcHRpb25hbFxuICogY3VzdG9tIGRvbWFpbiB3aXRoIFJvdXRlNTMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGNvbnN0IHNlcnZlciA9IG5ldyBBcHBUaGVvcnlNY3BTZXJ2ZXIodGhpcywgJ01jcFNlcnZlcicsIHtcbiAqICAgaGFuZGxlcjogbWNwRm4sXG4gKiAgIGVuYWJsZVNlc3Npb25UYWJsZTogdHJ1ZSxcbiAqICAgc2Vzc2lvblR0bE1pbnV0ZXM6IDEyMCxcbiAqIH0pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwU2VydmVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFRoZSBEeW5hbW9EQiBzZXNzaW9uIHRhYmxlIChpZiBlbmFibGVTZXNzaW9uVGFibGUgaXMgdHJ1ZSkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgTUNQIGVuZHBvaW50IFVSTCAoUE9TVCAvbWNwKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIHJlc291cmNlIChpZiBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluTmFtZT86IGFwaWd3djIuRG9tYWluTmFtZTtcblxuICAvKipcbiAgICogVGhlIEFQSSBtYXBwaW5nIGZvciB0aGUgY3VzdG9tIGRvbWFpbiAoaWYgZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBSb3V0ZTUzIENOQU1FIHJlY29yZCAoaWYgZG9tYWluIGFuZCBob3N0ZWRab25lIGFyZSBjb25maWd1cmVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQ7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIjtcblxuICAgIGNvbnN0IG5lZWRzRXhwbGljaXRTdGFnZSA9IHN0YWdlTmFtZSAhPT0gXCIkZGVmYXVsdFwiXG4gICAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZ1xuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQ7XG5cbiAgICAvLyBDcmVhdGUgSFRUUCBBUEkgd2l0aCBkZWZhdWx0IHN0YWdlXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgfSk7XG5cbiAgICAvLyBJZiBjdXN0b20gc3RhZ2Ugb3B0aW9ucywgY3JlYXRlIHRoZSBzdGFnZSBleHBsaWNpdGx5XG4gICAgbGV0IHN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAobmVlZHNFeHBsaWNpdFN0YWdlKSB7XG4gICAgICBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcblxuICAgICAgLy8gU2V0IHVwIGFjY2VzcyBsb2dnaW5nIGlmIGVuYWJsZWRcbiAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgICAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgICAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YWdlID0gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIC8vIEFkZCBQT1NUIC9tY3Agcm91dGUgd2l0aCBMYW1iZGEgaW50ZWdyYXRpb25cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvbWNwXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIk1jcEhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgLy8gT3B0aW9uYWwgc2Vzc2lvbiB0YWJsZVxuICAgIGlmIChwcm9wcy5lbmFibGVTZXNzaW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IHRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5zZXNzaW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJzZXNzaW9uSWRcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJleHBpcmVzQXRcIixcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcblxuICAgICAgdGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHByb3BzLmhhbmRsZXIpO1xuICAgICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0YWJsZTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zZXNzaW9uVGFibGUpIHtcbiAgICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfU0VTU0lPTl9UQUJMRVwiLCB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUpO1xuICAgICAgdGhpcy5hZGRFbnZpcm9ubWVudChwcm9wcy5oYW5kbGVyLCBcIk1DUF9TRVNTSU9OX1RUTF9NSU5VVEVTXCIsIFN0cmluZyhwcm9wcy5zZXNzaW9uVHRsTWludXRlcyA/PyA2MCkpO1xuICAgIH1cblxuICAgIC8vIE9wdGlvbmFsIGN1c3RvbSBkb21haW5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICBpZiAoIXN0YWdlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFNlcnZlcjogbm8gc3RhZ2UgYXZhaWxhYmxlIGZvciBkb21haW4gbWFwcGluZ1wiKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ocHJvcHMuZG9tYWluLCBzdGFnZSk7XG4gICAgICB0aGlzLmVuZHBvaW50ID0gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKGBodHRwczovLyR7cHJvcHMuZG9tYWluLmRvbWFpbk5hbWV9YCl9L21jcGA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIENvbXB1dGUgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgVVJMIChpbmNsdWRlIHN0YWdlIHBhdGggdW5sZXNzIHVzaW5nICRkZWZhdWx0KS5cbiAgICAgIGNvbnN0IGJhc2VVcmwgPSAoc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCIpXG4gICAgICAgID8gdGhpcy5hcGkuYXBpRW5kcG9pbnRcbiAgICAgICAgOiBgJHt0aGlzLmFwaS5hcGlFbmRwb2ludH0vJHtzdGFnZU5hbWV9YDtcbiAgICAgIHRoaXMuZW5kcG9pbnQgPSBgJHtzdHJpcFRyYWlsaW5nU2xhc2goYmFzZVVybCl9L21jcGA7XG4gICAgfVxuXG4gICAgLy8gSW5qZWN0IGVudmlyb25tZW50IHZhcmlhYmxlcyBpbnRvIHRoZSBMYW1iZGEgaGFuZGxlclxuICAgIHRoaXMuYWRkRW52aXJvbm1lbnQocHJvcHMuaGFuZGxlciwgXCJNQ1BfRU5EUE9JTlRcIiwgdGhpcy5lbmRwb2ludCk7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGFuIGVudmlyb25tZW50IHZhcmlhYmxlIHRvIHRoZSBMYW1iZGEgZnVuY3Rpb24uXG4gICAqIFVzZXMgYWRkRW52aXJvbm1lbnQgaWYgYXZhaWxhYmxlIChGdW5jdGlvbiksIG90aGVyd2lzZSB1c2VzIEwxIG92ZXJyaWRlLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRFbnZpcm9ubWVudChoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLCBrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmIChcImFkZEVudmlyb25tZW50XCIgaW4gaGFuZGxlciAmJiB0eXBlb2YgaGFuZGxlci5hZGRFbnZpcm9ubWVudCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBoYW5kbGVyLmFkZEVudmlyb25tZW50KGtleSwgdmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdXAgY3VzdG9tIGRvbWFpbiB3aXRoIG9wdGlvbmFsIFJvdXRlNTMgcmVjb3JkLlxuICAgKi9cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlNY3BTZXJ2ZXJEb21haW5PcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IGRvbWFpbk9wdHMuY2VydGlmaWNhdGUgPz8gKGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydFwiLCBkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuKSBhcyBhY20uSUNlcnRpZmljYXRlXG4gICAgICA6IHVuZGVmaW5lZCk7XG5cbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BTZXJ2ZXI6IGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG1uID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkbW47XG5cbiAgICBjb25zdCBtYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWU6IGRtbixcbiAgICAgIHN0YWdlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gbWFwcGluZztcblxuICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgIGRvbWFpbk5hbWU6IGRtbi5yZWdpb25hbERvbWFpbk5hbWUsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkIH0pLmNuYW1lUmVjb3JkID0gcmVjb3JkO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIENvbnZlcnQgYSBkb21haW4gbmFtZSB0byBhIFJvdXRlNTMgcmVjb3JkIG5hbWUgcmVsYXRpdmUgdG8gdGhlIHpvbmUuXG4gKi9cbmZ1bmN0aW9uIHRvUm91dGU1M1JlY29yZE5hbWUoZG9tYWluTmFtZTogc3RyaW5nLCB6b25lOiByb3V0ZTUzLklIb3N0ZWRab25lKTogc3RyaW5nIHtcbiAgY29uc3QgZnFkbiA9IFN0cmluZyhkb21haW5OYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGNvbnN0IHpvbmVOYW1lID0gU3RyaW5nKHpvbmUuem9uZU5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgaWYgKCF6b25lTmFtZSkgcmV0dXJuIGZxZG47XG4gIGlmIChmcWRuID09PSB6b25lTmFtZSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHN1ZmZpeCA9IGAuJHt6b25lTmFtZX1gO1xuICBpZiAoZnFkbi5lbmRzV2l0aChzdWZmaXgpKSB7XG4gICAgcmV0dXJuIGZxZG4uc2xpY2UoMCwgLXN1ZmZpeC5sZW5ndGgpO1xuICB9XG4gIHJldHVybiBmcWRuO1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cbiJdfQ==