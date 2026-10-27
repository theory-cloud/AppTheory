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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryApp", version: "6.4.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBd0U7QUFFeEUsd0VBQTBEO0FBQzFELG1FQUFxRDtBQUVyRCwrREFBaUQ7QUFHakQsMkNBQXVDO0FBR3ZDLHlDQUFtRjtBQUNuRix5Q0FJb0I7QUE0R3BCLE1BQWEsWUFBYSxTQUFRLHNCQUFTOztJQUN6QixHQUFHLENBQW1CO0lBQ3RCLEVBQUUsQ0FBb0I7SUFDdEIsYUFBYSxDQUFtQjtJQUNoQyxjQUFjLENBQW1CO0lBQ2pDLE1BQU0sQ0FBc0I7SUFDNUIsS0FBSyxDQUFnQjtJQUVyQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXdCO1FBQ2hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQ0FBcUMsQ0FBQyxDQUFDO1FBQ3pELENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDVixNQUFNLElBQUksS0FBSyxDQUFDLGdFQUFnRSxDQUFDLENBQUM7UUFDcEYsQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FDYiw4TEFBOEwsQ0FDL0wsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBMkIsRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLFdBQVcsSUFBSSxFQUFFLENBQUMsRUFBRSxDQUFDO1FBRXJFLElBQUksS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3hCLElBQUksQ0FBQyxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztZQUN6QyxHQUFHLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQ3BELENBQUM7YUFBTSxJQUFJLEtBQUssQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNoQyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsaUJBQWlCLElBQUksR0FBRyxPQUFPLFFBQVEsQ0FBQztZQUNoRSxNQUFNLGdCQUFnQixHQUFHLEtBQUssQ0FBQyxvQkFBb0IsSUFBSSxJQUFJLENBQUM7WUFFNUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtnQkFDeEQsU0FBUztnQkFDVCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO2dCQUNqRCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO2dCQUM3RSxPQUFPLEVBQUUsS0FBSyxDQUFDLGVBQWU7b0JBQzVCLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsZUFBZSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtvQkFDdEUsQ0FBQyxDQUFDLFNBQVM7Z0JBQ2IsbUJBQW1CLEVBQUUsS0FBSztnQkFDMUIsZ0NBQWdDLEVBQUU7b0JBQ2hDLDBCQUEwQixFQUFFLElBQUk7aUJBQ2pDO2dCQUNELFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7Z0JBQ2hELE1BQU0sRUFBRSxRQUFRLENBQUMsY0FBYyxDQUFDLGtCQUFrQjthQUNuRCxDQUFDLENBQUM7WUFFSCxHQUFHLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQ3BELENBQUM7UUFFRCxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQzdCLE1BQU0sU0FBUyxHQUFHLEtBQUssQ0FBQyxrQkFBa0IsSUFBSSxHQUFHLE9BQU8sY0FBYyxDQUFDO1lBRXZFLElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtnQkFDL0QsU0FBUztnQkFDVCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO2dCQUNqRCxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtnQkFDakUsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7Z0JBQzVELG1CQUFtQixFQUFFLEtBQUs7Z0JBQzFCLGdDQUFnQyxFQUFFO29CQUNoQywwQkFBMEIsRUFBRSxJQUFJO2lCQUNqQztnQkFDRCxVQUFVLEVBQUUsUUFBUSxDQUFDLGVBQWUsQ0FBQyxXQUFXO2FBQ2pELENBQUMsQ0FBQztZQUVILE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDO1lBQ3BELEdBQUcsQ0FBQywrQkFBK0IsR0FBRyxhQUFhLENBQUM7WUFDcEQsR0FBRyxDQUFDLHFCQUFxQixHQUFHLGFBQWEsQ0FBQztZQUMxQyxHQUFHLENBQUMsZ0JBQWdCLEdBQUcsYUFBYSxDQUFDO1lBQ3JDLEdBQUcsQ0FBQyxrQkFBa0IsR0FBRyxhQUFhLENBQUM7UUFDekMsQ0FBQztRQUVELElBQUksQ0FBQyxFQUFFLEdBQUcsSUFBSSw0QkFBaUIsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ2hELFlBQVksRUFBRSxPQUFPO1lBQ3JCLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsZUFBZTtZQUN4RCxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sSUFBSSxXQUFXO1lBQ3JDLElBQUk7WUFDSixXQUFXLEVBQUUsR0FBRztZQUNoQixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsT0FBTyxFQUFFLHNCQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxjQUFjLElBQUksRUFBRSxDQUFDO1lBQ3JELFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLGdCQUFnQjtZQUN4QyxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsY0FBYyxFQUFFLEtBQUssQ0FBQyxjQUFjO1lBQ3BDLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0I7WUFDeEMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtZQUMxQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1NBQ25CLENBQUMsQ0FBQztRQUNGLElBQWlDLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDO1FBRXpELElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksQ0FBQyxhQUFhLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNwRCxDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDeEIsSUFBSSxDQUFDLGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3JELENBQUM7UUFFRCxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksMkJBQWdCLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZQUMzQyxPQUFPLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFO1lBQ3BDLE9BQU8sRUFBRSxHQUFHLE9BQU8sTUFBTTtZQUN6QixJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsTUFBTSxFQUFFLHNCQUFzQixDQUFDLElBQUksRUFBRSxLQUFLLENBQUM7WUFDM0Msc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQjtTQUNyRCxDQUFDLENBQUM7UUFDRixJQUF3QyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQztRQUVuRSxNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUU3QixJQUFJLHVCQUFTLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRTtZQUM3QixLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLEVBQUU7WUFDN0IsV0FBVyxFQUFFLDBCQUEwQjtTQUN4QyxDQUFDLENBQUM7UUFFSCxJQUFJLHVCQUFTLENBQUMsS0FBSyxFQUFFLGNBQWMsRUFBRTtZQUNuQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsWUFBWTtZQUM5QixXQUFXLEVBQUUsc0JBQXNCO1NBQ3BDLENBQUMsQ0FBQztRQUVILElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3ZCLElBQUksdUJBQVMsQ0FBQyxLQUFLLEVBQUUsbUJBQW1CLEVBQUU7Z0JBQ3hDLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7Z0JBQ25DLFdBQVcsRUFBRSxxQkFBcUI7YUFDbkMsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUNILENBQUM7O0FBbElILG9DQW1JQztBQUVELFNBQVMsc0JBQXNCLENBQUMsS0FBZ0IsRUFBRSxLQUF3QjtJQUN4RSxJQUFJLEtBQUssQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLEtBQUssQ0FBQyxjQUFjLElBQUksS0FBSyxDQUFDLFVBQVUsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUNsRyxNQUFNLElBQUksS0FBSyxDQUFDLG1HQUFtRyxDQUFDLENBQUM7SUFDdkgsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2pCLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUN0QixDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxFQUFFLENBQUM7UUFDL0MsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUNELElBQUksQ0FBQyxLQUFLLENBQUMsVUFBVSxJQUFJLENBQUMsS0FBSyxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQy9DLE1BQU0sSUFBSSxLQUFLLENBQUMsd0ZBQXdGLENBQUMsQ0FBQztJQUM1RyxDQUFDO0lBQ0QsT0FBTztRQUNMLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVTtRQUM1QixXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLEVBQUUsYUFBYSxFQUFFLEtBQUssQ0FBQyxjQUFjLENBQUM7UUFDM0YsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO1FBQzVCLEtBQUssRUFBRSxLQUFLLENBQUMsS0FBSztLQUNuQixDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCB0eXBlICogYXMgZWMyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlGdW5jdGlvbiwgdHlwZSBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucyB9IGZyb20gXCIuL2Z1bmN0aW9uXCI7XG5pbXBvcnQge1xuICBBcHBUaGVvcnlIdHRwQXBpLFxuICB0eXBlIEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyxcbiAgdHlwZSBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyxcbn0gZnJvbSBcIi4vaHR0cC1hcGlcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5QXBwUHJvcHMge1xuICByZWFkb25seSBhcHBOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGVBc3NldFBhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvZGU/OiBsYW1iZGEuQ29kZTtcbiAgcmVhZG9ubHkgcnVudGltZT86IGxhbWJkYS5SdW50aW1lO1xuICByZWFkb25seSBoYW5kbGVyPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGVudmlyb25tZW50PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgcmVhZG9ubHkgbWVtb3J5U2l6ZT86IG51bWJlcjtcbiAgcmVhZG9ubHkgdGltZW91dFNlY29uZHM/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBSZXRlbnRpb24gZm9yIHRoZSBhcHAgZnVuY3Rpb24ncyBBcHBUaGVvcnktbWFuYWdlZCBuYW1lZCBsb2cgZ3JvdXAuXG4gICAqXG4gICAqIFRoZSB2YWx1ZSBpcyBmb3J3YXJkZWQgdW5jaGFuZ2VkIHRvIEFwcFRoZW9yeUZ1bmN0aW9uLCB3aGljaCBpZ25vcmVzIGl0XG4gICAqIHdoZW4gYGxvZ0dyb3VwYCBzdXBwbGllcyB0aGUgbG9nIGdyb3VwLlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBDb25maWd1cmUgYHJldGVudGlvbmAgb24gYW4gZXhwbGljaXQgYGxvZ3MuTG9nR3JvdXBgIGFuZCBwYXNzXG4gICAqIGl0IGFzIGBsb2dHcm91cGAgaW5zdGVhZC4gQXBwVGhlb3J5IGtlZXBzIGhvbm9yaW5nIHRoaXMgcHJvcGVydHkgZm9yXG4gICAqIGV4aXN0aW5nIHN0YWNrcyBhbmQgaGFzIG5vIHBsYW5uZWQgcmVtb3ZhbCBkYXRlLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIIGZvciBBcHBUaGVvcnktbWFuYWdlZCBsb2cgZ3JvdXBzXG4gICAqL1xuICByZWFkb25seSBsb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIC8qKlxuICAgKiBMb2cgZ3JvdXAgdGhlIGFwcCBmdW5jdGlvbiB3cml0ZXMgdG8uXG4gICAqXG4gICAqIFdoZW4gc2V0LCBBcHBUaGVvcnkgdXNlcyB0aGlzIGdyb3VwIHVuY2hhbmdlZDogdGhlIGNhbGxlciBvd25zIGl0c1xuICAgKiByZXRlbnRpb24gYW5kIHJlbW92YWwgcG9saWN5LiBgbG9nUmV0ZW50aW9uYCBpcyBpZ25vcmVkLCBhbmQgY29tYmluaW5nIHRoaXNcbiAgICogcHJvcGVydHkgd2l0aCBgbG9nUmVtb3ZhbFBvbGljeWAgZmFpbHMgc3ludGhlc2lzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBhbiBBcHBUaGVvcnktbWFuYWdlZCBsb2cgZ3JvdXAgbmFtZWQgYC9hd3MvbGFtYmRhLzxhcHBOYW1lPmBcbiAgICovXG4gIHJlYWRvbmx5IGxvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXBSZWY7XG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIGFwcCBmdW5jdGlvbidzIEFwcFRoZW9yeS1tYW5hZ2VkIG5hbWVkIGxvZyBncm91cC5cbiAgICpcbiAgICogVGhlIHZhbHVlIGlzIGZvcndhcmRlZCB1bmNoYW5nZWQgdG8gQXBwVGhlb3J5RnVuY3Rpb24uIFN1cHBseWluZyBib3RoXG4gICAqIGBsb2dHcm91cGAgYW5kIGBsb2dSZW1vdmFsUG9saWN5YCBmYWlscyBzeW50aGVzaXMgYmVjYXVzZSBjYWxsZXItcHJvdmlkZWRcbiAgICogbG9nIGdyb3VwcyBvd24gdGhlaXIgcmVtb3ZhbCBwb2xpY3kuXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIENvbmZpZ3VyZSBgcmVtb3ZhbFBvbGljeWAgb24gYW4gZXhwbGljaXQgYGxvZ3MuTG9nR3JvdXBgIGFuZFxuICAgKiBwYXNzIGl0IGFzIGBsb2dHcm91cGAgaW5zdGVhZC4gQXBwVGhlb3J5IGtlZXBzIGhvbm9yaW5nIHRoaXMgcHJvcGVydHkgZm9yXG4gICAqIGV4aXN0aW5nIHN0YWNrcyBhbmQgaGFzIG5vIHBsYW5uZWQgcmVtb3ZhbCBkYXRlLlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IHZwYz86IGVjMi5JVnBjO1xuICByZWFkb25seSB2cGNTdWJuZXRzPzogZWMyLlN1Ym5ldFNlbGVjdGlvbjtcbiAgcmVhZG9ubHkgc2VjdXJpdHlHcm91cHM/OiBlYzIuSVNlY3VyaXR5R3JvdXBbXTtcbiAgcmVhZG9ubHkgYWxsb3dBbGxPdXRib3VuZD86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFsbG93UHVibGljU3VibmV0PzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFN0YWJsZSBwaHlzaWNhbCBuYW1lIGZvciB0aGUgYXBwIGZ1bmN0aW9uJ3MgQXBwVGhlb3J5LW1hbmFnZWQgSUFNIHJvbGUuXG4gICAqXG4gICAqIEFwcFRoZW9yeUZ1bmN0aW9uIHJlY2VpdmVzIHRoZSB2YWx1ZSB1bmNoYW5nZWQuIENvbmNyZXRlIG5hbWVzIGFyZSBzeW50aGVzaXMtdmFsaWRhdGVkIGFnYWluc3QgSUFNJ3MgYFtcXHcrPSwuQC1dK2AgY2hhcmFjdGVyIHNldCBhbmQgNjQtY2hhcmFjdGVyIGxpbWl0OyB0b2tlbi12YWx1ZWQgbmFtZXMgYXJlIGFjY2VwdGVkIGFuZCBJQU0gdmFsaWRhdGVzIHRoZSByZXNvbHZlZCB2YWx1ZSBhdCBkZXBsb3kgdGltZSwgc28gYW4gaW52YWxpZCByZXNvbHZlZCBuYW1lIGZhaWxzIGRlcGxveW1lbnQgcmF0aGVyIHRoYW4gc3ludGhlc2lzLlxuICAgKiBUaGlzIGV4ZW1wdGlvbiBrZWVwcyBhY2NvdW50LWFnbm9zdGljIHN5bnRoZXNpcyByZXByZXNlbnRhYmxlIGZvciB0aGUgVEhFLTI4NjEgdG9rZW4tdmFsdWVkLWlucHV0IGZhaWx1cmUgY2xhc3MuIFN5bnRoZXNpcyBzdGlsbCBmYWlscyBpZiBBcHBUaGVvcnkgY2Fubm90IGFwcGx5IHRoZSByZXF1ZXN0ZWQgbmFtZSBleGFjdGx5LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJvbGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBhbGlhcz86IEFwcFRoZW9yeUZ1bmN0aW9uQWxpYXNPcHRpb25zO1xuXG4gIHJlYWRvbmx5IGVuYWJsZURhdGFiYXNlPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZGF0YWJhc2VUYWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRhdGFiYXNlUGFydGl0aW9uS2V5Pzogc3RyaW5nO1xuICByZWFkb25seSBkYXRhYmFzZVNvcnRLZXk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRhdGFiYXNlVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG5cbiAgcmVhZG9ubHkgZW5hYmxlUmF0ZUxpbWl0aW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgcmF0ZUxpbWl0VGFibGVOYW1lPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucztcbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG4gIC8qKlxuICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBpcyBpbnRlbnRpb25hbGx5IHVuYXZhaWxhYmxlIG9uIEFwcFRoZW9yeUFwcFxuICAgKiBiZWNhdXNlIHRoaXMgdG9wLWxldmVsIGNvbnN0cnVjdCBkZXBsb3lzIGFuIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJLlxuICAgKiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2YgcHJvZHVjaW5nIGFuXG4gICAqIHVuc3VwcG9ydGVkIEhUVFAgQVBJIFdlYkFDTCBhc3NvY2lhdGlvbi5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aGVuIGEgV0FGLXByb3RlY3RlZCBBUElcbiAgICogR2F0ZXdheSBzdGFnZSBpcyByZXF1aXJlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqIEBkZXByZWNhdGVkIEFwcFRoZW9yeUFwcCB1c2VzIEFwcFRoZW9yeUh0dHBBcGk7IEhUVFAgQVBJIFdBRiBhc3NvY2lhdGlvbiBpcyB1bnN1cHBvcnRlZCBieSBBV1MgV0FGdjIuXG4gICAqL1xuICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zO1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIEZvcndhcmRlZCB1bmNoYW5nZWQgdG8gdGhlIGlubmVyIGBBcHBUaGVvcnlIdHRwQXBpYC4gV2hlbiBmYWxzZSwgb25lIEFQSS1zY29wZWQgaW52b2tlXG4gICAqIHBlcm1pc3Npb24gaXMgZ3JhbnRlZCBwZXIgTGFtYmRhIGluc3RlYWQgb2Ygb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLCB3aGljaCBpcyB0aGVcbiAgICogc2NhbGFibGUgY2hvaWNlIHdoZW4gdGhlIGFwcCBMYW1iZGEgaXMgc2hhcmVkIHdpdGggb3RoZXIgcm91dGVzIG9uIHRoZSBzYW1lIEhUVFAgQVBJIGFuZFxuICAgKiB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5QXBwIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogQXBwVGhlb3J5SHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IGZuOiBBcHBUaGVvcnlGdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGRhdGFiYXNlVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSByYXRlTGltaXRUYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbjtcbiAgcHVibGljIHJlYWRvbmx5IGFsaWFzPzogbGFtYmRhLkFsaWFzO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlBcHBQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBhcHBOYW1lID0gU3RyaW5nKHByb3BzLmFwcE5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICghYXBwTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBwIHJlcXVpcmVzIHByb3BzLmFwcE5hbWVcIik7XG4gICAgfVxuXG4gICAgY29uc3QgY29kZSA9IHByb3BzLmNvZGUgPz8gKHByb3BzLmNvZGVBc3NldFBhdGggPyBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocHJvcHMuY29kZUFzc2V0UGF0aCkgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY29kZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5QXBwIHJlcXVpcmVzIGVpdGhlciBwcm9wcy5jb2RlIG9yIHByb3BzLmNvZGVBc3NldFBhdGhcIik7XG4gICAgfVxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlBcHAgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGJlY2F1c2UgaXQgZGVwbG95cyBhbiBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSTsgdXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBmb3IgV0FGLXByb3RlY3RlZCBSRVNUIHN0YWdlc1wiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLihwcm9wcy5lbnZpcm9ubWVudCA/PyB7fSkgfTtcblxuICAgIGlmIChwcm9wcy5kYXRhYmFzZVRhYmxlKSB7XG4gICAgICB0aGlzLmRhdGFiYXNlVGFibGUgPSBwcm9wcy5kYXRhYmFzZVRhYmxlO1xuICAgICAgZW52LkRZTkFNT0RCX1RBQkxFID0gdGhpcy5kYXRhYmFzZVRhYmxlLnRhYmxlTmFtZTtcbiAgICB9IGVsc2UgaWYgKHByb3BzLmVuYWJsZURhdGFiYXNlKSB7XG4gICAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5kYXRhYmFzZVRhYmxlTmFtZSA/PyBgJHthcHBOYW1lfS10YWJsZWA7XG4gICAgICBjb25zdCBwYXJ0aXRpb25LZXlOYW1lID0gcHJvcHMuZGF0YWJhc2VQYXJ0aXRpb25LZXkgPz8gXCJJRFwiO1xuXG4gICAgICB0aGlzLmRhdGFiYXNlVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJEYXRhYmFzZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IHBhcnRpdGlvbktleU5hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHNvcnRLZXk6IHByb3BzLmRhdGFiYXNlU29ydEtleVxuICAgICAgICAgID8geyBuYW1lOiBwcm9wcy5kYXRhYmFzZVNvcnRLZXksIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH1cbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgICBzdHJlYW06IGR5bmFtb2RiLlN0cmVhbVZpZXdUeXBlLk5FV19BTkRfT0xEX0lNQUdFUyxcbiAgICAgIH0pO1xuXG4gICAgICBlbnYuRFlOQU1PREJfVEFCTEUgPSB0aGlzLmRhdGFiYXNlVGFibGUudGFibGVOYW1lO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5lbmFibGVSYXRlTGltaXRpbmcpIHtcbiAgICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnJhdGVMaW1pdFRhYmxlTmFtZSA/PyBgJHthcHBOYW1lfS1yYXRlLWxpbWl0c2A7XG5cbiAgICAgIHRoaXMucmF0ZUxpbWl0VGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJSYXRlTGltaXRUYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBcInNrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByYXRlTGltaXROYW1lID0gdGhpcy5yYXRlTGltaXRUYWJsZS50YWJsZU5hbWU7XG4gICAgICBlbnYuQVBQVEhFT1JZX1JBVEVfTElNSVRfVEFCTEVfTkFNRSA9IHJhdGVMaW1pdE5hbWU7XG4gICAgICBlbnYuUkFURV9MSU1JVF9UQUJMRV9OQU1FID0gcmF0ZUxpbWl0TmFtZTtcbiAgICAgIGVudi5SQVRFX0xJTUlUX1RBQkxFID0gcmF0ZUxpbWl0TmFtZTtcbiAgICAgIGVudi5MSU1JVEVEX1RBQkxFX05BTUUgPSByYXRlTGltaXROYW1lO1xuICAgIH1cblxuICAgIHRoaXMuZm4gPSBuZXcgQXBwVGhlb3J5RnVuY3Rpb24odGhpcywgXCJGdW5jdGlvblwiLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGFwcE5hbWUsXG4gICAgICBydW50aW1lOiBwcm9wcy5ydW50aW1lID8/IGxhbWJkYS5SdW50aW1lLlBST1ZJREVEX0FMMjAyMyxcbiAgICAgIGhhbmRsZXI6IHByb3BzLmhhbmRsZXIgPz8gXCJib290c3RyYXBcIixcbiAgICAgIGNvZGUsXG4gICAgICBlbnZpcm9ubWVudDogZW52LFxuICAgICAgbWVtb3J5U2l6ZTogcHJvcHMubWVtb3J5U2l6ZSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMocHJvcHMudGltZW91dFNlY29uZHMgPz8gMzApLFxuICAgICAgbG9nUmV0ZW50aW9uOiBwcm9wcy5sb2dSZXRlbnRpb24sXG4gICAgICBsb2dHcm91cDogcHJvcHMubG9nR3JvdXAsXG4gICAgICBsb2dSZW1vdmFsUG9saWN5OiBwcm9wcy5sb2dSZW1vdmFsUG9saWN5LFxuICAgICAgdnBjOiBwcm9wcy52cGMsXG4gICAgICB2cGNTdWJuZXRzOiBwcm9wcy52cGNTdWJuZXRzLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IHByb3BzLnNlY3VyaXR5R3JvdXBzLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogcHJvcHMuYWxsb3dBbGxPdXRib3VuZCxcbiAgICAgIGFsbG93UHVibGljU3VibmV0OiBwcm9wcy5hbGxvd1B1YmxpY1N1Ym5ldCxcbiAgICAgIHJvbGVOYW1lOiBwcm9wcy5yb2xlTmFtZSxcbiAgICAgIGFsaWFzOiBwcm9wcy5hbGlhcyxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFsaWFzPzogbGFtYmRhLkFsaWFzIH0pLmFsaWFzID0gdGhpcy5mbi5hbGlhcztcblxuICAgIGlmICh0aGlzLmRhdGFiYXNlVGFibGUpIHtcbiAgICAgIHRoaXMuZGF0YWJhc2VUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodGhpcy5mbi5mbik7XG4gICAgfVxuICAgIGlmICh0aGlzLnJhdGVMaW1pdFRhYmxlKSB7XG4gICAgICB0aGlzLnJhdGVMaW1pdFRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmZuLmZuKTtcbiAgICB9XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBBcHBUaGVvcnlIdHRwQXBpKHRoaXMsIFwiQVBJXCIsIHtcbiAgICAgIGhhbmRsZXI6IHRoaXMuZm4uYWxpYXMgPz8gdGhpcy5mbi5mbixcbiAgICAgIGFwaU5hbWU6IGAke2FwcE5hbWV9LWFwaWAsXG4gICAgICBjb3JzOiBwcm9wcy5jb3JzLFxuICAgICAgZG9tYWluOiBub3JtYWxpemVEb21haW5PcHRpb25zKHRoaXMsIHByb3BzKSxcbiAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW4gfSkuZG9tYWluID0gdGhpcy5hcGkuZG9tYWluO1xuXG4gICAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZih0aGlzKTtcblxuICAgIG5ldyBDZm5PdXRwdXQoc3RhY2ssIFwiQXBpVXJsXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmFwaS5hcGkudXJsID8/IFwiXCIsXG4gICAgICBkZXNjcmlwdGlvbjogXCJBUEkgR2F0ZXdheSBlbmRwb2ludCBVUkxcIixcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQoc3RhY2ssIFwiRnVuY3Rpb25OYW1lXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmZuLmZuLmZ1bmN0aW9uTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBcIkxhbWJkYSBmdW5jdGlvbiBuYW1lXCIsXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5kYXRhYmFzZVRhYmxlKSB7XG4gICAgICBuZXcgQ2ZuT3V0cHV0KHN0YWNrLCBcIkRhdGFiYXNlVGFibGVOYW1lXCIsIHtcbiAgICAgICAgdmFsdWU6IHRoaXMuZGF0YWJhc2VUYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIkR5bmFtb0RCIHRhYmxlIG5hbWVcIixcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVEb21haW5PcHRpb25zKHNjb3BlOiBDb25zdHJ1Y3QsIHByb3BzOiBBcHBUaGVvcnlBcHBQcm9wcyk6IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHByb3BzLmRvbWFpbiAmJiAocHJvcHMuZG9tYWluTmFtZSB8fCBwcm9wcy5jZXJ0aWZpY2F0ZUFybiB8fCBwcm9wcy5ob3N0ZWRab25lIHx8IHByb3BzLnN0YWdlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUFwcCBjdXN0b20gZG9tYWluIG11c3QgdXNlIGVpdGhlciBwcm9wcy5kb21haW4gb3IgbGVnYWN5IGRvbWFpbk5hbWUvY2VydGlmaWNhdGVBcm4gcHJvcHNcIik7XG4gIH1cbiAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgIHJldHVybiBwcm9wcy5kb21haW47XG4gIH1cbiAgaWYgKCFwcm9wcy5kb21haW5OYW1lICYmICFwcm9wcy5jZXJ0aWZpY2F0ZUFybikge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKCFwcm9wcy5kb21haW5OYW1lIHx8ICFwcm9wcy5jZXJ0aWZpY2F0ZUFybikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUFwcCByZXF1aXJlcyBib3RoIHByb3BzLmRvbWFpbk5hbWUgYW5kIHByb3BzLmNlcnRpZmljYXRlQXJuIGZvciBjdXN0b20gZG9tYWluXCIpO1xuICB9XG4gIHJldHVybiB7XG4gICAgZG9tYWluTmFtZTogcHJvcHMuZG9tYWluTmFtZSxcbiAgICBjZXJ0aWZpY2F0ZTogYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihzY29wZSwgXCJDZXJ0aWZpY2F0ZVwiLCBwcm9wcy5jZXJ0aWZpY2F0ZUFybiksXG4gICAgaG9zdGVkWm9uZTogcHJvcHMuaG9zdGVkWm9uZSxcbiAgICBzdGFnZTogcHJvcHMuc3RhZ2UsXG4gIH07XG59XG4iXX0=