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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApp", version: "4.4.1-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBd0U7QUFFeEUsd0VBQTBEO0FBQzFELG1FQUFxRDtBQUVyRCwrREFBaUQ7QUFHakQsMkNBQXVDO0FBR3ZDLHlDQUFtRjtBQUNuRix5Q0FJb0I7QUFxRnBCLE1BQWEsWUFBYSxTQUFRLHNCQUFTOztJQUN6QixHQUFHLENBQW1CO0lBQ3RCLEVBQUUsQ0FBb0I7SUFDdEIsYUFBYSxDQUFtQjtJQUNoQyxjQUFjLENBQW1CO0lBQ2pDLE1BQU0sQ0FBc0I7SUFDNUIsS0FBSyxDQUFnQjtJQUVyQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXdCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQ0FBcUMsQ0FBQyxDQUFDO1FBQ3pELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDVixNQUFNLElBQUksS0FBSyxDQUFDLGdFQUFnRSxDQUFDLENBQUM7UUFDcEYsQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FDYiw4TEFBOEwsQ0FDL0wsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBMkIsRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLFdBQVcsSUFBSSxFQUFFLENBQUMsRUFBRSxDQUFDO1FBRXJFLElBQUksS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3hCLElBQUksQ0FBQyxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztZQUN6QyxHQUFHLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQ3BELENBQUM7YUFBTSxJQUFJLEtBQUssQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNoQyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsaUJBQWlCLElBQUksR0FBRyxPQUFPLFFBQVEsQ0FBQztZQUNoRSxNQUFNLGdCQUFnQixHQUFHLEtBQUssQ0FBQyxvQkFBb0IsSUFBSSxJQUFJLENBQUM7WUFFNUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtnQkFDeEQsU0FBUztnQkFDVCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO2dCQUNqRCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO2dCQUM3RSxPQUFPLEVBQUUsS0FBSyxDQUFDLGVBQWU7b0JBQzVCLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsZUFBZSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtvQkFDdEUsQ0FBQyxDQUFDLFNBQVM7Z0JBQ2IsbUJBQW1CLEVBQUUsS0FBSztnQkFDMUIsZ0NBQWdDLEVBQUU7b0JBQ2hDLDBCQUEwQixFQUFFLElBQUk7aUJBQ2pDO2dCQUNELFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7Z0JBQ2hELE1BQU0sRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLGtCQUFrQjthQUNuRCxDQUFDLENBQUM7WUFFSCxHQUFHLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQ3BELENBQUM7UUFFRCxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQzdCLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxrQkFBa0IsSUFBSSxHQUFHLE9BQU8sY0FBYyxDQUFDO1lBRXZFLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDL0QsU0FBUztnQkFDVCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO2dCQUNqRCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7Z0JBQzVELG1CQUFtQixFQUFFLEtBQUs7Z0JBQzFCLGdDQUFnQyxFQUFFO29CQUNoQywwQkFBMEIsRUFBRSxJQUFJO2lCQUNqQztnQkFDRCxVQUFVLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQyxXQUFXO2FBQ2pELENBQUMsQ0FBQztZQUVILE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDO1lBQ3BELEdBQUcsQ0FBQywrQkFBK0IsR0FBRyxhQUFhLENBQUM7WUFDcEQsR0FBRyxDQUFDLHFCQUFxQixHQUFHLGFBQWEsQ0FBQztZQUMxQyxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsYUFBYSxDQUFDO1lBQ3JDLEdBQUcsQ0FBQyxrQkFBa0IsR0FBRyxhQUFhLENBQUM7UUFDekMsQ0FBQztRQUVELElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSw0QkFBaUIsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2hELFlBQVksRUFBRSxPQUFPO1lBQ3JCLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsZUFBZTtZQUN4RCxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sSUFBSSxXQUFXO1lBQ3JDLElBQUk7WUFDSixXQUFXLEVBQUUsR0FBRztZQUNoQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsT0FBTyxFQUFFLHNCQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksRUFBRSxDQUFDO1lBQ3JELFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLGdCQUFnQjtZQUN4QyxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjO1lBQ3BDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDeEMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtZQUMxQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1NBQ25CLENBQUMsQ0FBQztRQUNGLElBQWlDLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDO1FBRXpELElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksQ0FBQyxhQUFhLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNwRCxDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDeEIsSUFBSSxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3JELENBQUM7UUFFRCxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksMkJBQWdCLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZQUMzQyxPQUFPLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFO1lBQ3BDLE9BQU8sRUFBRSxHQUFHLE9BQU8sTUFBTTtZQUN6QixJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsTUFBTSxFQUFFLHNCQUFzQixDQUFDLElBQUksRUFBRSxLQUFLLENBQUM7WUFDM0Msc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQjtTQUNyRCxDQUFDLENBQUM7UUFDRixJQUF3QyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQztRQUVuRSxNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUU3QixJQUFJLHVCQUFTLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRTtZQUM3QixLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLEVBQUU7WUFDN0IsV0FBVyxFQUFFLDBCQUEwQjtTQUN4QyxDQUFDLENBQUM7UUFFSCxJQUFJLHVCQUFTLENBQUMsS0FBSyxFQUFFLGNBQWMsRUFBRTtZQUNuQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsWUFBWTtZQUM5QixXQUFXLEVBQUUsc0JBQXNCO1NBQ3BDLENBQUMsQ0FBQztRQUVILElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksdUJBQVMsQ0FBQyxLQUFLLEVBQUUsbUJBQW1CLEVBQUU7Z0JBQ3hDLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7Z0JBQ25DLFdBQVcsRUFBRSxxQkFBcUI7YUFDbkMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUNILENBQUM7O0FBbElILG9DQW1JQztBQUVELFNBQVMsc0JBQXNCLENBQUMsS0FBZ0IsRUFBRSxLQUF3QjtJQUN4RSxJQUFJLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLEtBQUssQ0FBQyxjQUFjLElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNsRyxNQUFNLElBQUksS0FBSyxDQUFDLG1HQUFtRyxDQUFDLENBQUM7SUFDdkgsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2pCLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUN0QixDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDL0MsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQy9DLE1BQU0sSUFBSSxLQUFLLENBQUMsd0ZBQXdGLENBQUMsQ0FBQztJQUM1RyxDQUFDO0lBQ0QsT0FBTztRQUNMLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtRQUM1QixXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsYUFBYSxFQUFFLEtBQUssQ0FBQyxjQUFjLENBQUM7UUFDM0YsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztLQUNuQixDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgZWMyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlGdW5jdGlvbiwgdHlwZSBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucyB9IGZyb20gXCIuL2Z1bmN0aW9uXCI7XG5pbXBvcnQge1xuICBBcHBUaGVvcnlIdHRwQXBpLFxuICB0eXBlIEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyxcbiAgdHlwZSBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyxcbn0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QXBwUHJvcHMge1xuICByZWFkb25seSBhcHBOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGVBc3NldFBhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGU/OiBsYW1iZGEuQ29kZTtcbiAgcmVhZG9ubHkgcnVudGltZT86IGxhbWJkYS5SdW50aW1lO1xuICByZWFkb25seSBoYW5kbGVyPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGVudmlyb25tZW50PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgcmVhZG9ubHkgbWVtb3J5U2l6ZT86IG51bWJlcjtcbiAgcmVhZG9ubHkgdGltZW91dFNlY29uZHM/OiBudW1iZXI7XG4gIHJlYWRvbmx5IGxvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cFJlZjtcbiAgLyoqXG4gICAqIFJlbW92YWwgcG9saWN5IGZvciB0aGUgYXBwIGZ1bmN0aW9uJ3MgQXBwVGhlb3J5LW1hbmFnZWQgbmFtZWQgbG9nIGdyb3VwLlxuICAgKlxuICAgKiBUaGUgdmFsdWUgaXMgZm9yd2FyZGVkIHVuY2hhbmdlZCB0byBBcHBUaGVvcnlGdW5jdGlvbi4gU3VwcGx5aW5nIGJvdGhcbiAgICogYGxvZ0dyb3VwYCBhbmQgYGxvZ1JlbW92YWxQb2xpY3lgIGZhaWxzIHN5bnRoZXNpcyBiZWNhdXNlIGNhbGxlci1wcm92aWRlZFxuICAgKiBsb2cgZ3JvdXBzIG93biB0aGVpciByZW1vdmFsIHBvbGljeS5cbiAgICpcbiAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5ERVNUUk9ZXG4gICAqL1xuICByZWFkb25seSBsb2dSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG4gIHJlYWRvbmx5IHZwY1N1Ym5ldHM/OiBlYzIuU3VibmV0U2VsZWN0aW9uO1xuICByZWFkb25seSBzZWN1cml0eUdyb3Vwcz86IGVjMi5JU2VjdXJpdHlHcm91cFtdO1xuICByZWFkb25seSBhbGxvd0FsbE91dGJvdW5kPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWxsb3dQdWJsaWNTdWJuZXQ/OiBib29sZWFuO1xuICAvKipcbiAgICogU3RhYmxlIHBoeXNpY2FsIG5hbWUgZm9yIHRoZSBhcHAgZnVuY3Rpb24ncyBBcHBUaGVvcnktbWFuYWdlZCBJQU0gcm9sZS5cbiAgICpcbiAgICogQXBwVGhlb3J5RnVuY3Rpb24gcmVjZWl2ZXMgdGhlIHZhbHVlIHVuY2hhbmdlZC4gQ29uY3JldGUgbmFtZXMgYXJlIHN5bnRoZXNpcy12YWxpZGF0ZWQgYWdhaW5zdCBJQU0ncyBgW1xcdys9LC5ALV0rYCBjaGFyYWN0ZXIgc2V0IGFuZCA2NC1jaGFyYWN0ZXIgbGltaXQ7IHRva2VuLXZhbHVlZCBuYW1lcyBhcmUgYWNjZXB0ZWQgYW5kIElBTSB2YWxpZGF0ZXMgdGhlIHJlc29sdmVkIHZhbHVlIGF0IGRlcGxveSB0aW1lLCBzbyBhbiBpbnZhbGlkIHJlc29sdmVkIG5hbWUgZmFpbHMgZGVwbG95bWVudCByYXRoZXIgdGhhbiBzeW50aGVzaXMuXG4gICAqIFRoaXMgZXhlbXB0aW9uIGtlZXBzIGFjY291bnQtYWdub3N0aWMgc3ludGhlc2lzIHJlcHJlc2VudGFibGUgZm9yIHRoZSBUSEUtMjg2MSB0b2tlbi12YWx1ZWQtaW5wdXQgZmFpbHVyZSBjbGFzcy4gU3ludGhlc2lzIHN0aWxsIGZhaWxzIGlmIEFwcFRoZW9yeSBjYW5ub3QgYXBwbHkgdGhlIHJlcXVlc3RlZCBuYW1lIGV4YWN0bHkuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm9sZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFsaWFzPzogQXBwVGhlb3J5RnVuY3Rpb25BbGlhc09wdGlvbnM7XG5cbiAgcmVhZG9ubHkgZW5hYmxlRGF0YWJhc2U/OiBib29sZWFuO1xuICByZWFkb25seSBkYXRhYmFzZVRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZGF0YWJhc2VQYXJ0aXRpb25LZXk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRhdGFiYXNlU29ydEtleT86IHN0cmluZztcbiAgcmVhZG9ubHkgZGF0YWJhc2VUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcblxuICByZWFkb25seSBlbmFibGVSYXRlTGltaXRpbmc/OiBib29sZWFuO1xuICByZWFkb25seSByYXRlTGltaXRUYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgZG9tYWluTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcbiAgLyoqXG4gICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGlzIGludGVudGlvbmFsbHkgdW5hdmFpbGFibGUgb24gQXBwVGhlb3J5QXBwXG4gICAqIGJlY2F1c2UgdGhpcyB0b3AtbGV2ZWwgY29uc3RydWN0IGRlcGxveXMgYW4gQVBJIEdhdGV3YXkgdjIgSFRUUCBBUEkuXG4gICAqIFN1cHBseWluZyB0aGlzIHByb3AgZmFpbHMgY2xvc2VkIGR1cmluZyBzeW50aGVzaXMgaW5zdGVhZCBvZiBwcm9kdWNpbmcgYW5cbiAgICogdW5zdXBwb3J0ZWQgSFRUUCBBUEkgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgQXBwVGhlb3J5QXBwIHVzZXMgQXBwVGhlb3J5SHR0cEFwaTsgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnM7XG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuICByZWFkb25seSBzdGFnZT86IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogRm9yd2FyZGVkIHVuY2hhbmdlZCB0byB0aGUgaW5uZXIgYEFwcFRoZW9yeUh0dHBBcGlgLiBXaGVuIGZhbHNlLCBvbmUgQVBJLXNjb3BlZCBpbnZva2VcbiAgICogcGVybWlzc2lvbiBpcyBncmFudGVkIHBlciBMYW1iZGEgaW5zdGVhZCBvZiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUsIHdoaWNoIGlzIHRoZVxuICAgKiBzY2FsYWJsZSBjaG9pY2Ugd2hlbiB0aGUgYXBwIExhbWJkYSBpcyBzaGFyZWQgd2l0aCBvdGhlciByb3V0ZXMgb24gdGhlIHNhbWUgSFRUUCBBUEkgYW5kXG4gICAqIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZSBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlBcHAgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBBcHBUaGVvcnlIdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgZm46IEFwcFRoZW9yeUZ1bmN0aW9uO1xuICBwdWJsaWMgcmVhZG9ubHkgZGF0YWJhc2VUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IHJhdGVMaW1pdFRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxpYXM/OiBsYW1iZGEuQWxpYXM7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUFwcFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IGFwcE5hbWUgPSBTdHJpbmcocHJvcHMuYXBwTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFhcHBOYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcHAgcmVxdWlyZXMgcHJvcHMuYXBwTmFtZVwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb2RlID0gcHJvcHMuY29kZSA/PyAocHJvcHMuY29kZUFzc2V0UGF0aCA/IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwcm9wcy5jb2RlQXNzZXRQYXRoKSA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjb2RlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlBcHAgcmVxdWlyZXMgZWl0aGVyIHByb3BzLmNvZGUgb3IgcHJvcHMuY29kZUFzc2V0UGF0aFwiKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUFwcCBkb2VzIG5vdCBzdXBwb3J0IFdBRnYyIHJlZ2lvbmFsIFdlYkFDTCBhc3NvY2lhdGlvbnMgYmVjYXVzZSBpdCBkZXBsb3lzIGFuIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJOyB1c2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGZvciBXQUYtcHJvdGVjdGVkIFJFU1Qgc3RhZ2VzXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uKHByb3BzLmVudmlyb25tZW50ID8/IHt9KSB9O1xuXG4gICAgaWYgKHByb3BzLmRhdGFiYXNlVGFibGUpIHtcbiAgICAgIHRoaXMuZGF0YWJhc2VUYWJsZSA9IHByb3BzLmRhdGFiYXNlVGFibGU7XG4gICAgICBlbnYuRFlOQU1PREJfVEFCTEUgPSB0aGlzLmRhdGFiYXNlVGFibGUudGFibGVOYW1lO1xuICAgIH0gZWxzZSBpZiAocHJvcHMuZW5hYmxlRGF0YWJhc2UpIHtcbiAgICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLmRhdGFiYXNlVGFibGVOYW1lID8/IGAke2FwcE5hbWV9LXRhYmxlYDtcbiAgICAgIGNvbnN0IHBhcnRpdGlvbktleU5hbWUgPSBwcm9wcy5kYXRhYmFzZVBhcnRpdGlvbktleSA/PyBcIklEXCI7XG5cbiAgICAgIHRoaXMuZGF0YWJhc2VUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkRhdGFiYXNlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogcGFydGl0aW9uS2V5TmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogcHJvcHMuZGF0YWJhc2VTb3J0S2V5XG4gICAgICAgICAgPyB7IG5hbWU6IHByb3BzLmRhdGFiYXNlU29ydEtleSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICAgIHN0cmVhbTogZHluYW1vZGIuU3RyZWFtVmlld1R5cGUuTkVXX0FORF9PTERfSU1BR0VTLFxuICAgICAgfSk7XG5cbiAgICAgIGVudi5EWU5BTU9EQl9UQUJMRSA9IHRoaXMuZGF0YWJhc2VUYWJsZS50YWJsZU5hbWU7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmVuYWJsZVJhdGVMaW1pdGluZykge1xuICAgICAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMucmF0ZUxpbWl0VGFibGVOYW1lID8/IGAke2FwcE5hbWV9LXJhdGUtbGltaXRzYDtcblxuICAgICAgdGhpcy5yYXRlTGltaXRUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlJhdGVMaW1pdFRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJwa1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IFwic2tcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJhdGVMaW1pdE5hbWUgPSB0aGlzLnJhdGVMaW1pdFRhYmxlLnRhYmxlTmFtZTtcbiAgICAgIGVudi5BUFBUSEVPUllfUkFURV9MSU1JVF9UQUJMRV9OQU1FID0gcmF0ZUxpbWl0TmFtZTtcbiAgICAgIGVudi5SQVRFX0xJTUlUX1RBQkxFX05BTUUgPSByYXRlTGltaXROYW1lO1xuICAgICAgZW52LlJBVEVfTElNSVRfVEFCTEUgPSByYXRlTGltaXROYW1lO1xuICAgICAgZW52LkxJTUlURURfVEFCTEVfTkFNRSA9IHJhdGVMaW1pdE5hbWU7XG4gICAgfVxuXG4gICAgdGhpcy5mbiA9IG5ldyBBcHBUaGVvcnlGdW5jdGlvbih0aGlzLCBcIkZ1bmN0aW9uXCIsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYXBwTmFtZSxcbiAgICAgIHJ1bnRpbWU6IHByb3BzLnJ1bnRpbWUgPz8gbGFtYmRhLlJ1bnRpbWUuUFJPVklERURfQUwyMDIzLFxuICAgICAgaGFuZGxlcjogcHJvcHMuaGFuZGxlciA/PyBcImJvb3RzdHJhcFwiLFxuICAgICAgY29kZSxcbiAgICAgIGVudmlyb25tZW50OiBlbnYsXG4gICAgICBtZW1vcnlTaXplOiBwcm9wcy5tZW1vcnlTaXplLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcyhwcm9wcy50aW1lb3V0U2Vjb25kcyA/PyAzMCksXG4gICAgICBsb2dSZXRlbnRpb246IHByb3BzLmxvZ1JldGVudGlvbixcbiAgICAgIGxvZ0dyb3VwOiBwcm9wcy5sb2dHcm91cCxcbiAgICAgIGxvZ1JlbW92YWxQb2xpY3k6IHByb3BzLmxvZ1JlbW92YWxQb2xpY3ksXG4gICAgICB2cGM6IHByb3BzLnZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHByb3BzLnZwY1N1Ym5ldHMsXG4gICAgICBzZWN1cml0eUdyb3VwczogcHJvcHMuc2VjdXJpdHlHcm91cHMsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiBwcm9wcy5hbGxvd0FsbE91dGJvdW5kLFxuICAgICAgYWxsb3dQdWJsaWNTdWJuZXQ6IHByb3BzLmFsbG93UHVibGljU3VibmV0LFxuICAgICAgcm9sZU5hbWU6IHByb3BzLnJvbGVOYW1lLFxuICAgICAgYWxpYXM6IHByb3BzLmFsaWFzLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYWxpYXM/OiBsYW1iZGEuQWxpYXMgfSkuYWxpYXMgPSB0aGlzLmZuLmFsaWFzO1xuXG4gICAgaWYgKHRoaXMuZGF0YWJhc2VUYWJsZSkge1xuICAgICAgdGhpcy5kYXRhYmFzZVRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmZuLmZuKTtcbiAgICB9XG4gICAgaWYgKHRoaXMucmF0ZUxpbWl0VGFibGUpIHtcbiAgICAgIHRoaXMucmF0ZUxpbWl0VGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuZm4uZm4pO1xuICAgIH1cblxuICAgIHRoaXMuYXBpID0gbmV3IEFwcFRoZW9yeUh0dHBBcGkodGhpcywgXCJBUElcIiwge1xuICAgICAgaGFuZGxlcjogdGhpcy5mbi5hbGlhcyA/PyB0aGlzLmZuLmZuLFxuICAgICAgYXBpTmFtZTogYCR7YXBwTmFtZX0tYXBpYCxcbiAgICAgIGNvcnM6IHByb3BzLmNvcnMsXG4gICAgICBkb21haW46IG5vcm1hbGl6ZURvbWFpbk9wdGlvbnModGhpcywgcHJvcHMpLFxuICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbiB9KS5kb21haW4gPSB0aGlzLmFwaS5kb21haW47XG5cbiAgICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHRoaXMpO1xuXG4gICAgbmV3IENmbk91dHB1dChzdGFjaywgXCJBcGlVcmxcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuYXBpLmFwaS51cmwgPz8gXCJcIixcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkFQSSBHYXRld2F5IGVuZHBvaW50IFVSTFwiLFxuICAgIH0pO1xuXG4gICAgbmV3IENmbk91dHB1dChzdGFjaywgXCJGdW5jdGlvbk5hbWVcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuZm4uZm4uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246IFwiTGFtYmRhIGZ1bmN0aW9uIG5hbWVcIixcbiAgICB9KTtcblxuICAgIGlmICh0aGlzLmRhdGFiYXNlVGFibGUpIHtcbiAgICAgIG5ldyBDZm5PdXRwdXQoc3RhY2ssIFwiRGF0YWJhc2VUYWJsZU5hbWVcIiwge1xuICAgICAgICB2YWx1ZTogdGhpcy5kYXRhYmFzZVRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgZGVzY3JpcHRpb246IFwiRHluYW1vREIgdGFibGUgbmFtZVwiLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZURvbWFpbk9wdGlvbnMoc2NvcGU6IENvbnN0cnVjdCwgcHJvcHM6IEFwcFRoZW9yeUFwcFByb3BzKTogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMgfCB1bmRlZmluZWQge1xuICBpZiAocHJvcHMuZG9tYWluICYmIChwcm9wcy5kb21haW5OYW1lIHx8IHByb3BzLmNlcnRpZmljYXRlQXJuIHx8IHByb3BzLmhvc3RlZFpvbmUgfHwgcHJvcHMuc3RhZ2UpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBwIGN1c3RvbSBkb21haW4gbXVzdCB1c2UgZWl0aGVyIHByb3BzLmRvbWFpbiBvciBsZWdhY3kgZG9tYWluTmFtZS9jZXJ0aWZpY2F0ZUFybiBwcm9wc1wiKTtcbiAgfVxuICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgcmV0dXJuIHByb3BzLmRvbWFpbjtcbiAgfVxuICBpZiAoIXByb3BzLmRvbWFpbk5hbWUgJiYgIXByb3BzLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoIXByb3BzLmRvbWFpbk5hbWUgfHwgIXByb3BzLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBwIHJlcXVpcmVzIGJvdGggcHJvcHMuZG9tYWluTmFtZSBhbmQgcHJvcHMuY2VydGlmaWNhdGVBcm4gZm9yIGN1c3RvbSBkb21haW5cIik7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBkb21haW5OYW1lOiBwcm9wcy5kb21haW5OYW1lLFxuICAgIGNlcnRpZmljYXRlOiBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHNjb3BlLCBcIkNlcnRpZmljYXRlXCIsIHByb3BzLmNlcnRpZmljYXRlQXJuKSxcbiAgICBob3N0ZWRab25lOiBwcm9wcy5ob3N0ZWRab25lLFxuICAgIHN0YWdlOiBwcm9wcy5zdGFnZSxcbiAgfTtcbn1cbiJdfQ==