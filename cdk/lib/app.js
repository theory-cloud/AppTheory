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
exports.AppTheoryApp = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const constructs_1 = require("constructs");
const function_1 = require("./function");
const http_api_1 = require("./http-api");
class AppTheoryApp extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApp", version: "6.1.0" };
    api;
    fn;
    databaseTable;
    rateLimitTable;
    domain;
    alias;
    constructor(scope, id, props) {
        super(scope, id);
        const appName = String(props.appName ?? "").trim();
        if (!appName) {
            throw new Error("AppTheoryApp requires props.appName");
        }
        const code = props.code ?? (props.codeAssetPath ? lambda.Code.fromAsset(props.codeAssetPath) : undefined);
        if (!code) {
            throw new Error("AppTheoryApp requires either props.code or props.codeAssetPath");
        }
        if (props.waf) {
            throw new Error("AppTheoryApp does not support WAFv2 regional WebACL associations because it deploys an API Gateway v2 HTTP API; use AppTheoryRestApi or AppTheoryRestApiRouter for WAF-protected REST stages");
        }
        const env = { ...(props.environment ?? {}) };
        if (props.databaseTable) {
            this.databaseTable = props.databaseTable;
            env.DYNAMODB_TABLE = this.databaseTable.tableName;
        }
        else if (props.enableDatabase) {
            const tableName = props.databaseTableName ?? `${appName}-table`;
            const partitionKeyName = props.databasePartitionKey ?? "ID";
            this.databaseTable = new dynamodb.Table(this, "Database", {
                tableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: partitionKeyName, type: dynamodb.AttributeType.STRING },
                sortKey: props.databaseSortKey
                    ? { name: props.databaseSortKey, type: dynamodb.AttributeType.STRING }
                    : undefined,
                timeToLiveAttribute: "ttl",
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
                stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            });
            env.DYNAMODB_TABLE = this.databaseTable.tableName;
        }
        if (props.enableRateLimiting) {
            const tableName = props.rateLimitTableName ?? `${appName}-rate-limits`;
            this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
                tableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
                sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: "ttl",
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: true,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
            const rateLimitName = this.rateLimitTable.tableName;
            env.APPTHEORY_RATE_LIMIT_TABLE_NAME = rateLimitName;
            env.RATE_LIMIT_TABLE_NAME = rateLimitName;
            env.RATE_LIMIT_TABLE = rateLimitName;
            env.LIMITED_TABLE_NAME = rateLimitName;
        }
        this.fn = new function_1.AppTheoryFunction(this, "Function", {
            functionName: appName,
            runtime: props.runtime ?? lambda.Runtime.PROVIDED_AL2023,
            handler: props.handler ?? "bootstrap",
            code,
            environment: env,
            memorySize: props.memorySize,
            timeout: aws_cdk_lib_1.Duration.seconds(props.timeoutSeconds ?? 30),
            logRetention: props.logRetention,
            logGroup: props.logGroup,
            logRemovalPolicy: props.logRemovalPolicy,
            vpc: props.vpc,
            vpcSubnets: props.vpcSubnets,
            securityGroups: props.securityGroups,
            allowAllOutbound: props.allowAllOutbound,
            allowPublicSubnet: props.allowPublicSubnet,
            roleName: props.roleName,
            alias: props.alias,
        });
        this.alias = this.fn.alias;
        if (this.databaseTable) {
            this.databaseTable.grantReadWriteData(this.fn.fn);
        }
        if (this.rateLimitTable) {
            this.rateLimitTable.grantReadWriteData(this.fn.fn);
        }
        this.api = new http_api_1.AppTheoryHttpApi(this, "API", {
            handler: this.fn.alias ?? this.fn.fn,
            apiName: `${appName}-api`,
            cors: props.cors,
            domain: normalizeDomainOptions(this, props),
            scopePermissionToRoute: props.scopePermissionToRoute,
        });
        this.domain = this.api.domain;
        const stack = aws_cdk_lib_1.Stack.of(this);
        new aws_cdk_lib_1.CfnOutput(stack, "ApiUrl", {
            value: this.api.api.url ?? "",
            description: "API Gateway endpoint URL",
        });
        new aws_cdk_lib_1.CfnOutput(stack, "FunctionName", {
            value: this.fn.fn.functionName,
            description: "Lambda function name",
        });
        if (this.databaseTable) {
            new aws_cdk_lib_1.CfnOutput(stack, "DatabaseTableName", {
                value: this.databaseTable.tableName,
                description: "DynamoDB table name",
            });
        }
    }
}
exports.AppTheoryApp = AppTheoryApp;
function normalizeDomainOptions(scope, props) {
    if (props.domain && (props.domainName || props.certificateArn || props.hostedZone || props.stage)) {
        throw new Error("AppTheoryApp custom domain must use either props.domain or legacy domainName/certificateArn props");
    }
    if (props.domain) {
        return props.domain;
    }
    if (!props.domainName && !props.certificateArn) {
        return undefined;
    }
    if (!props.domainName || !props.certificateArn) {
        throw new Error("AppTheoryApp requires both props.domainName and props.certificateArn for custom domain");
    }
    return {
        domainName: props.domainName,
        certificate: acm.Certificate.fromCertificateArn(scope, "Certificate", props.certificateArn),
        hostedZone: props.hostedZone,
        stage: props.stage,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBd0U7QUFFeEUsd0VBQTBEO0FBQzFELG1FQUFxRDtBQUVyRCwrREFBaUQ7QUFHakQsMkNBQXVDO0FBR3ZDLHlDQUFtRjtBQUNuRix5Q0FJb0I7QUFxRnBCLE1BQWEsWUFBYSxTQUFRLHNCQUFTOztJQUN6QixHQUFHLENBQW1CO0lBQ3RCLEVBQUUsQ0FBb0I7SUFDdEIsYUFBYSxDQUFtQjtJQUNoQyxjQUFjLENBQW1CO0lBQ2pDLE1BQU0sQ0FBc0I7SUFDNUIsS0FBSyxDQUFnQjtJQUVyQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXdCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQ0FBcUMsQ0FBQyxDQUFDO1FBQ3pELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDVixNQUFNLElBQUksS0FBSyxDQUFDLGdFQUFnRSxDQUFDLENBQUM7UUFDcEYsQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FDYiw4TEFBOEwsQ0FD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Q0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLEtBQUssQ0FBQyxjQUFjLElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNsRyxNQUFNLElBQUksS0FBSyxDQUFDLG1HQUFtRyxDQUFDLENBQUM7SUFDdkgsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2pCLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUN0QixDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDL0MsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQy9DLE1BQU0sSUFBSSxLQUFLLENBQUMsd0ZBQXdGLENBQUMsQ0FBQztJQUM1RyxDQUFDO0lBQ0QsT0FBTztRQUNMLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtRQUM1QixXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsYUFBYSxFQUFFLEtBQUssQ0FBQyxjQUFjLENBQUM7UUFDM0YsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztLQUNuQixDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgZWMyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlGdW5jdGlvbiwgdHlwZSBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucyB9IGZyb20gXCIuL2Z1bmN0aW9uXCI7XG5pbXBvcnQge1xuICBBcHBUaGVvcnlIdHRwQXBpLFxuICB0eXBlIEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyxcbiAgdHlwZSBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyxcbn0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QXBwUHJvcHMge1xuICByZWFkb25seSBhcHBOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGVBc3NldFBhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGU/OiBsYW1iZGEuQ29kZTtcbiAgcmVhZG9ubHkgcnVudGltZT86IGxhbWJkYS5SdW50aW1lO1xuICByZWFkb25seSBoYW5kbGVyPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGVudmlyb25tZW50PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgcmVhZG9ubHkgbWVtb3J5U2l6ZT86IG51bWJlcjtcbiAgcmVhZG9ubHkgdGltZW91dFNlY29uZHM/OiBudW1iZXI7XG4gIHJlYWRvbmx5IGxvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cFJlZjtcbiAgLyoqXG4gICAqIFJlbW92YWwgcG9saWN5IGZvciB0aGUgYXBwIGZ1bmN0aW9uJ3MgQXBwVGhlb3J5LW1hbmFnZWQgbmFtZWQgbG9nIGdyb3VwLlxuICAgKlxuICAgKiBUaGUgdmFsdWUgaXMgZm9yd2FyZGVkIHVuY2hhbmdlZCB0byBBcHBUaGVvcnlGdW5jdGlvbi4gU3VwcGx5aW5nIGJvdGhcbiAgICogYGxvZ0dyb3VwYCBhbmQgYGxvZ1JlbW92YWxQb2xpY3lgIGZhaWxzIHN5bnRoZXNpcyBiZWNhdXNlIGNhbGxlci1wcm92aWRlZFxuICAgKiBsb2cgZ3JvdXBzIG93biB0aGVpciByZW1vdmFsIHBvbGljeS5cbiAgICpcbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICovXG4gIHJlYWRvbmx5IGxvZ1JlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSB2cGM/OiBlYzIuSVZwYztcbiAgcmVhZG9ubHkgdnBjU3VibmV0cz86IGVjMi5TdWJuZXRTZWxlY3Rpb247XG4gIHJlYWRvbmx5IHNlY3VyaXR5R3JvdXBzPzogZWMyLklTZWN1cml0eUdyb3VwW107XG4gIHJlYWRvbmx5IGFsbG93QWxsT3V0Ym91bmQ/OiBib29sZWFuO1xuICByZWFkb25seSBhbGxvd1B1YmxpY1N1Ym5ldD86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBTdGFibGUgcGh5c2ljYWwgbmFtZSBmb3IgdGhlIGFwcCBmdW5jdGlvbidzIEFwcFRoZW9yeS1tYW5hZ2VkIElBTSByb2xlLlxuICAgKlxuICAgKiBBcHBUaGVvcnlGdW5jdGlvbiByZWNlaXZlcyB0aGUgdmFsdWUgdW5jaGFuZ2VkLiBDb25jcmV0ZSBuYW1lcyBhcmUgc3ludGhlc2lzLXZhbGlkYXRlZCBhZ2FpbnN0IElBTSdzIGBbXFx3Kz0sLkAtXStgIGNoYXJhY3RlciBzZXQgYW5kIDY0LWNoYXJhY3RlciBsaW1pdDsgdG9rZW4tdmFsdWVkIG5hbWVzIGFyZSBhY2NlcHRlZCBhbmQgSUFNIHZhbGlkYXRlcyB0aGUgcmVzb2x2ZWQgdmFsdWUgYXQgZGVwbG95IHRpbWUsIHNvIGFuIGludmFsaWQgcmVzb2x2ZWQgbmFtZSBmYWlscyBkZXBsb3ltZW50IHJhdGhlciB0aGFuIHN5bnRoZXNpcy5cbiAgICogVGhpcyBleGVtcHRpb24ga2VlcHMgYWNjb3VudC1hZ25vc3RpYyBzeW50aGVzaXMgcmVwcmVzZW50YWJsZSBmb3IgdGhlIFRIRS0yODYxIHRva2VuLXZhbHVlZC1pbnB1dCBmYWlsdXJlIGNsYXNzLiBTeW50aGVzaXMgc3RpbGwgZmFpbHMgaWYgQXBwVGhlb3J5IGNhbm5vdCBhcHBseSB0aGUgcmVxdWVzdGVkIG5hbWUgZXhhY3RseS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb2xlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgYWxpYXM/OiBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucztcblxuICByZWFkb25seSBlbmFibGVEYXRhYmFzZT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGRhdGFiYXNlVGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBkYXRhYmFzZVBhcnRpdGlvbktleT86IHN0cmluZztcbiAgcmVhZG9ubHkgZGF0YWJhc2VTb3J0S2V5Pzogc3RyaW5nO1xuICByZWFkb25seSBkYXRhYmFzZVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuXG4gIHJlYWRvbmx5IGVuYWJsZVJhdGVMaW1pdGluZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHJhdGVMaW1pdFRhYmxlTmFtZT86IHN0cmluZztcblxuICByZWFkb25seSBkb21haW5OYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnM7XG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBvbiBBcHBUaGVvcnlBcHBcbiAgICogYmVjYXVzZSB0aGlzIHRvcC1sZXZlbCBjb25zdHJ1Y3QgZGVwbG95cyBhbiBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSS5cbiAgICogU3VwcGx5aW5nIHRoaXMgcHJvcCBmYWlscyBjbG9zZWQgZHVyaW5nIHN5bnRoZXNpcyBpbnN0ZWFkIG9mIHByb2R1Y2luZyBhblxuICAgKiB1bnN1cHBvcnRlZCBIVFRQIEFQSSBXZWJBQ0wgYXNzb2NpYXRpb24uXG4gICAqXG4gICAqIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2hlbiBhIFdBRi1wcm90ZWN0ZWQgQVBJXG4gICAqIEdhdGV3YXkgc3RhZ2UgaXMgcmVxdWlyZWQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKiBAZGVwcmVjYXRlZCBBcHBUaGVvcnlBcHAgdXNlcyBBcHBUaGVvcnlIdHRwQXBpOyBIVFRQIEFQSSBXQUYgYXNzb2NpYXRpb24gaXMgdW5zdXBwb3J0ZWQgYnkgQVdTIFdBRnYyLlxuICAgKi9cbiAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucztcbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG4gIHJlYWRvbmx5IHN0YWdlPzogYXBpZ3d2Mi5JU3RhZ2U7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBGb3J3YXJkZWQgdW5jaGFuZ2VkIHRvIHRoZSBpbm5lciBgQXBwVGhlb3J5SHR0cEFwaWAuIFdoZW4gZmFsc2UsIG9uZSBBUEktc2NvcGVkIGludm9rZVxuICAgKiBwZXJtaXNzaW9uIGlzIGdyYW50ZWQgcGVyIExhbWJkYSBpbnN0ZWFkIG9mIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZSwgd2hpY2ggaXMgdGhlXG4gICAqIHNjYWxhYmxlIGNob2ljZSB3aGVuIHRoZSBhcHAgTGFtYmRhIGlzIHNoYXJlZCB3aXRoIG90aGVyIHJvdXRlcyBvbiB0aGUgc2FtZSBIVFRQIEFQSSBhbmRcbiAgICogdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUFwcCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IEFwcFRoZW9yeUh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBmbjogQXBwVGhlb3J5RnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBkYXRhYmFzZVRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmF0ZUxpbWl0VGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW47XG4gIHB1YmxpYyByZWFkb25seSBhbGlhcz86IGxhbWJkYS5BbGlhcztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5QXBwUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgYXBwTmFtZSA9IFN0cmluZyhwcm9wcy5hcHBOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICBpZiAoIWFwcE5hbWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUFwcCByZXF1aXJlcyBwcm9wcy5hcHBOYW1lXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGNvZGUgPSBwcm9wcy5jb2RlID8/IChwcm9wcy5jb2RlQXNzZXRQYXRoID8gbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHByb3BzLmNvZGVBc3NldFBhdGgpIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNvZGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUFwcCByZXF1aXJlcyBlaXRoZXIgcHJvcHMuY29kZSBvciBwcm9wcy5jb2RlQXNzZXRQYXRoXCIpO1xuICAgIH1cbiAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5QXBwIGRvZXMgbm90IHN1cHBvcnQgV0FGdjIgcmVnaW9uYWwgV2ViQUNMIGFzc29jaWF0aW9ucyBiZWNhdXNlIGl0IGRlcGxveXMgYW4gQVBJIEdhdGV3YXkgdjIgSFRUUCBBUEk7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi4ocHJvcHMuZW52aXJvbm1lbnQgPz8ge30pIH07XG5cbiAgICBpZiAocHJvcHMuZGF0YWJhc2VUYWJsZSkge1xuICAgICAgdGhpcy5kYXRhYmFzZVRhYmxlID0gcHJvcHMuZGF0YWJhc2VUYWJsZTtcbiAgICAgIGVudi5EWU5BTU9EQl9UQUJMRSA9IHRoaXMuZGF0YWJhc2VUYWJsZS50YWJsZU5hbWU7XG4gICAgfSBlbHNlIGlmIChwcm9wcy5lbmFibGVEYXRhYmFzZSkge1xuICAgICAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuZGF0YWJhc2VUYWJsZU5hbWUgPz8gYCR7YXBwTmFtZX0tdGFibGVgO1xuICAgICAgY29uc3QgcGFydGl0aW9uS2V5TmFtZSA9IHByb3BzLmRhdGFiYXNlUGFydGl0aW9uS2V5ID8/IFwiSURcIjtcblxuICAgICAgdGhpcy5kYXRhYmFzZVRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiRGF0YWJhc2VcIiwge1xuICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBwYXJ0aXRpb25LZXlOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiBwcm9wcy5kYXRhYmFzZVNvcnRLZXlcbiAgICAgICAgICA/IHsgbmFtZTogcHJvcHMuZGF0YWJhc2VTb3J0S2V5LCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgICAgc3RyZWFtOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfQU5EX09MRF9JTUFHRVMsXG4gICAgICB9KTtcblxuICAgICAgZW52LkRZTkFNT0RCX1RBQkxFID0gdGhpcy5kYXRhYmFzZVRhYmxlLnRhYmxlTmFtZTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZW5hYmxlUmF0ZUxpbWl0aW5nKSB7XG4gICAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5yYXRlTGltaXRUYWJsZU5hbWUgPz8gYCR7YXBwTmFtZX0tcmF0ZS1saW1pdHNgO1xuXG4gICAgICB0aGlzLnJhdGVMaW1pdFRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiUmF0ZUxpbWl0VGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgcmF0ZUxpbWl0TmFtZSA9IHRoaXMucmF0ZUxpbWl0VGFibGUudGFibGVOYW1lO1xuICAgICAgZW52LkFQUFRIRU9SWV9SQVRFX0xJTUlUX1RBQkxFX05BTUUgPSByYXRlTGltaXROYW1lO1xuICAgICAgZW52LlJBVEVfTElNSVRfVEFCTEVfTkFNRSA9IHJhdGVMaW1pdE5hbWU7XG4gICAgICBlbnYuUkFURV9MSU1JVF9UQUJMRSA9IHJhdGVMaW1pdE5hbWU7XG4gICAgICBlbnYuTElNSVRFRF9UQUJMRV9OQU1FID0gcmF0ZUxpbWl0TmFtZTtcbiAgICB9XG5cbiAgICB0aGlzLmZuID0gbmV3IEFwcFRoZW9yeUZ1bmN0aW9uKHRoaXMsIFwiRnVuY3Rpb25cIiwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBhcHBOYW1lLFxuICAgICAgcnVudGltZTogcHJvcHMucnVudGltZSA/PyBsYW1iZGEuUnVudGltZS5QUk9WSURFRF9BTDIwMjMsXG4gICAgICBoYW5kbGVyOiBwcm9wcy5oYW5kbGVyID8/IFwiYm9vdHN0cmFwXCIsXG4gICAgICBjb2RlLFxuICAgICAgZW52aXJvbm1lbnQ6IGVudixcbiAgICAgIG1lbW9yeVNpemU6IHByb3BzLm1lbW9yeVNpemUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKHByb3BzLnRpbWVvdXRTZWNvbmRzID8/IDMwKSxcbiAgICAgIGxvZ1JldGVudGlvbjogcHJvcHMubG9nUmV0ZW50aW9uLFxuICAgICAgbG9nR3JvdXA6IHByb3BzLmxvZ0dyb3VwLFxuICAgICAgbG9nUmVtb3ZhbFBvbGljeTogcHJvcHMubG9nUmVtb3ZhbFBvbGljeSxcbiAgICAgIHZwYzogcHJvcHMudnBjLFxuICAgICAgdnBjU3VibmV0czogcHJvcHMudnBjU3VibmV0cyxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBwcm9wcy5zZWN1cml0eUdyb3VwcyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHByb3BzLmFsbG93QWxsT3V0Ym91bmQsXG4gICAgICBhbGxvd1B1YmxpY1N1Ym5ldDogcHJvcHMuYWxsb3dQdWJsaWNTdWJuZXQsXG4gICAgICByb2xlTmFtZTogcHJvcHMucm9sZU5hbWUsXG4gICAgICBhbGlhczogcHJvcHMuYWxpYXMsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhbGlhcz86IGxhbWJkYS5BbGlhcyB9KS5hbGlhcyA9IHRoaXMuZm4uYWxpYXM7XG5cbiAgICBpZiAodGhpcy5kYXRhYmFzZVRhYmxlKSB7XG4gICAgICB0aGlzLmRhdGFiYXNlVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuZm4uZm4pO1xuICAgIH1cbiAgICBpZiAodGhpcy5yYXRlTGltaXRUYWJsZSkge1xuICAgICAgdGhpcy5yYXRlTGltaXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodGhpcy5mbi5mbik7XG4gICAgfVxuXG4gICAgdGhpcy5hcGkgPSBuZXcgQXBwVGhlb3J5SHR0cEFwaSh0aGlzLCBcIkFQSVwiLCB7XG4gICAgICBoYW5kbGVyOiB0aGlzLmZuLmFsaWFzID8/IHRoaXMuZm4uZm4sXG4gICAgICBhcGlOYW1lOiBgJHthcHBOYW1lfS1hcGlgLFxuICAgICAgY29yczogcHJvcHMuY29ycyxcbiAgICAgIGRvbWFpbjogbm9ybWFsaXplRG9tYWluT3B0aW9ucyh0aGlzLCBwcm9wcyksXG4gICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluIH0pLmRvbWFpbiA9IHRoaXMuYXBpLmRvbWFpbjtcblxuICAgIGNvbnN0IHN0YWNrID0gU3RhY2sub2YodGhpcyk7XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHN0YWNrLCBcIkFwaVVybFwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5hcGkuYXBpLnVybCA/PyBcIlwiLFxuICAgICAgZGVzY3JpcHRpb246IFwiQVBJIEdhdGV3YXkgZW5kcG9pbnQgVVJMXCIsXG4gICAgfSk7XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHN0YWNrLCBcIkZ1bmN0aW9uTmFtZVwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5mbi5mbi5mdW5jdGlvbk5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogXCJMYW1iZGEgZnVuY3Rpb24gbmFtZVwiLFxuICAgIH0pO1xuXG4gICAgaWYgKHRoaXMuZGF0YWJhc2VUYWJsZSkge1xuICAgICAgbmV3IENmbk91dHB1dChzdGFjaywgXCJEYXRhYmFzZVRhYmxlTmFtZVwiLCB7XG4gICAgICAgIHZhbHVlOiB0aGlzLmRhdGFiYXNlVGFibGUudGFibGVOYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJEeW5hbW9EQiB0YWJsZSBuYW1lXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRG9tYWluT3B0aW9ucyhzY29wZTogQ29uc3RydWN0LCBwcm9wczogQXBwVGhlb3J5QXBwUHJvcHMpOiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyB8IHVuZGVmaW5lZCB7XG4gIGlmIChwcm9wcy5kb21haW4gJiYgKHByb3BzLmRvbWFpbk5hbWUgfHwgcHJvcHMuY2VydGlmaWNhdGVBcm4gfHwgcHJvcHMuaG9zdGVkWm9uZSB8fCBwcm9wcy5zdGFnZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcHAgY3VzdG9tIGRvbWFpbiBtdXN0IHVzZSBlaXRoZXIgcHJvcHMuZG9tYWluIG9yIGxlZ2FjeSBkb21haW5OYW1lL2NlcnRpZmljYXRlQXJuIHByb3BzXCIpO1xuICB9XG4gIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICByZXR1cm4gcHJvcHMuZG9tYWluO1xuICB9XG4gIGlmICghcHJvcHMuZG9tYWluTmFtZSAmJiAhcHJvcHMuY2VydGlmaWNhdGVBcm4pIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGlmICghcHJvcHMuZG9tYWluTmFtZSB8fCAhcHJvcHMuY2VydGlmaWNhdGVBcm4pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcHAgcmVxdWlyZXMgYm90aCBwcm9wcy5kb21haW5OYW1lIGFuZCBwcm9wcy5jZXJ0aWZpY2F0ZUFybiBmb3IgY3VzdG9tIGRvbWFpblwiKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGRvbWFpbk5hbWU6IHByb3BzLmRvbWFpbk5hbWUsXG4gICAgY2VydGlmaWNhdGU6IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4oc2NvcGUsIFwiQ2VydGlmaWNhdGVcIiwgcHJvcHMuY2VydGlmaWNhdGVBcm4pLFxuICAgIGhvc3RlZFpvbmU6IHByb3BzLmhvc3RlZFpvbmUsXG4gICAgc3RhZ2U6IHByb3BzLnN0YWdlLFxuICB9O1xufVxuIl19