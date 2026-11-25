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
exports.AppTheoryFunction = exports.AppTheoryLambdaTrafficShiftType = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const codedeploy = __importStar(require("aws-cdk-lib/aws-codedeploy"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
/**
 * Traffic shifting mode for AppTheory-managed Lambda aliases.
 */
var AppTheoryLambdaTrafficShiftType;
(function (AppTheoryLambdaTrafficShiftType) {
    /**
     * Shift all traffic to the new version at once.
     */
    AppTheoryLambdaTrafficShiftType["ALL_AT_ONCE"] = "ALL_AT_ONCE";
    /**
     * Shift one canary increment, wait, then shift the remaining traffic.
     */
    AppTheoryLambdaTrafficShiftType["CANARY"] = "CANARY";
    /**
     * Shift traffic in equal linear increments.
     */
    AppTheoryLambdaTrafficShiftType["LINEAR"] = "LINEAR";
})(AppTheoryLambdaTrafficShiftType || (exports.AppTheoryLambdaTrafficShiftType = AppTheoryLambdaTrafficShiftType = {}));
class AppTheoryFunction extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunction", version: "7.5.0-rc.3" };
    fn;
    logGroup;
    alias;
    deploymentGroup;
    constructor(scope, id, props) {
        super(scope, id);
        const { alias, roleName, namingContext, logicalName, ...inputLambdaProps } = props;
        const lambdaProps = { ...inputLambdaProps };
        const logical = logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        if (lambdaProps.role && roleName !== undefined) {
            throw new Error("AppTheoryFunction cannot honor props.roleName when props.role supplies the execution role; omit props.role or configure its name where that role is created");
        }
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryFunction", "functionName", "lambda_function", logical, lambdaProps.functionName !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryFunction", "roleName", "iam_role", logical, roleName !== undefined);
        const logRetention = lambdaProps.logRetention ?? logs.RetentionDays.ONE_MONTH;
        const requestedLogRemovalPolicy = lambdaProps.logRemovalPolicy;
        if (lambdaProps.logGroup && requestedLogRemovalPolicy !== undefined) {
            throw new Error("AppTheoryFunction cannot honor props.logRemovalPolicy when props.logGroup supplies the log group; omit props.logRemovalPolicy or configure the removal policy where that log group is created");
        }
        delete lambdaProps.logRetention;
        delete lambdaProps.logRemovalPolicy;
        delete lambdaProps.logRetentionRetryOptions;
        delete lambdaProps.logRetentionRole;
        let effectiveRoleName = roleName;
        if (namingContext && logical) {
            const composed = namingContext.physicalName("lambda_function", logical);
            if (!composed.generated) {
                lambdaProps.functionName = composed.name;
            }
            if (!lambdaProps.role) {
                const role = namingContext.physicalName("iam_role", logical);
                effectiveRoleName = role.generated ? undefined : role.name;
            }
        }
        let boundLogGroup = lambdaProps.logGroup;
        const standardLogging = namingContext?.standardLogging === true;
        if (standardLogging) {
            if (lambdaProps.logGroup) {
                throw new Error("AppTheoryFunction cannot combine props.logGroup with a standard logging profile; the profile owns the runtime log group");
            }
            if (!namingContext || !logical) {
                throw new Error("AppTheoryFunction standard logging requires a naming context and a logical name");
            }
            boundLogGroup = new logs.LogGroup(this, "RuntimeLogGroup", {
                logGroupName: namingContext.logGroupName(`logs/runtime/${logical}`),
                retention: namingContext.retentionDays,
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.RETAIN,
            });
        }
        if (!boundLogGroup && !standardLogging && lambdaProps.functionName) {
            boundLogGroup = createManagedFunctionLogGroup(this, `/aws/lambda/${lambdaProps.functionName}`, logRetention, requestedLogRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN);
        }
        this.fn = new lambda.Function(this, "Function", {
            ...lambdaProps,
            logGroup: boundLogGroup,
            architecture: lambdaProps.architecture ?? lambda.Architecture.ARM_64,
            tracing: lambdaProps.tracing ?? lambda.Tracing.ACTIVE,
            memorySize: lambdaProps.memorySize ?? 256,
            timeout: lambdaProps.timeout ?? aws_cdk_lib_1.Duration.seconds(10),
        });
        if (effectiveRoleName !== undefined) {
            if (!aws_cdk_lib_1.Token.isUnresolved(effectiveRoleName)) {
                if (!effectiveRoleName.trim()) {
                    throw new Error("AppTheoryFunction roleName must not be empty");
                }
                if (effectiveRoleName.length > 64) {
                    throw new Error("AppTheoryFunction roleName must not exceed 64 characters");
                }
                if (!/^[\w+=,.@-]+$/.test(effectiveRoleName)) {
                    throw new Error("AppTheoryFunction roleName must match [\\w+=,.@-]+");
                }
            }
            const roleResource = this.fn.role?.node.defaultChild;
            if (!(roleResource instanceof iam.CfnRole)) {
                throw new Error(`AppTheoryFunction cannot apply the required stable roleName ${JSON.stringify(effectiveRoleName)} because the Lambda execution role's default child is not an AWS::IAM::Role`);
            }
            roleResource.addPropertyOverride("RoleName", effectiveRoleName);
        }
        if (boundLogGroup) {
            this.logGroup = boundLogGroup;
            if (standardLogging) {
                boundLogGroup.grantWrite(this.fn);
            }
        }
        else {
            // Anonymous Lambda physical names are generated by CloudFormation. Keep
            // the finite-retention log group, but require callers that need a
            // fail-safe existing-stack upgrade/adoption path to pass logGroup or a
            // concrete functionName so the Lambda L2 can bind the group up front.
            const logGroup = createManagedFunctionLogGroup(this, `/aws/lambda/${this.fn.functionName}`, logRetention, requestedLogRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN);
            this.logGroup = logGroup;
        }
        if (alias) {
            this.configureAlias(alias);
        }
    }
    configureAlias(options) {
        const aliasName = String(options.name ?? "live").trim();
        if (!aliasName) {
            throw new Error("AppTheoryFunction alias.name must not be empty");
        }
        const alias = new lambda.Alias(this, "Alias", {
            aliasName,
            version: this.fn.currentVersion,
            description: options.description,
            provisionedConcurrentExecutions: options.provisionedConcurrentExecutions,
        });
        this.alias = alias;
        if (options.deployment) {
            const deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, "DeploymentGroup", {
                alias,
                deploymentConfig: deploymentConfigFor(this, options.deployment),
                alarms: options.deployment.alarms,
                preHook: options.deployment.preHook,
                postHook: options.deployment.postHook,
                autoRollback: options.deployment.autoRollback,
            });
            this.deploymentGroup = deploymentGroup;
        }
    }
}
exports.AppTheoryFunction = AppTheoryFunction;
function createManagedFunctionLogGroup(scope, logGroupName, retention, removalPolicy) {
    if (removalPolicy === aws_cdk_lib_1.RemovalPolicy.SNAPSHOT) {
        throw new Error("AppTheoryFunction cannot apply RemovalPolicy.SNAPSHOT because AWS::Logs::LogGroup does not support snapshot removal policies");
    }
    const logGroup = new logs.LogGroup(scope, "LogGroup", {
        logGroupName,
        retention,
    });
    const logGroupResource = logGroup.node.defaultChild;
    if (!(logGroupResource instanceof logs.CfnLogGroup)) {
        throw new Error(`AppTheoryFunction cannot apply logRemovalPolicy ${JSON.stringify(removalPolicy)} because the AppTheory-managed log group's default child is not an AWS::Logs::LogGroup`);
    }
    logGroupResource.applyRemovalPolicy(removalPolicy);
    return logGroup;
}
function deploymentConfigFor(scope, options) {
    const type = options.trafficShiftType ?? AppTheoryLambdaTrafficShiftType.CANARY;
    switch (type) {
        case AppTheoryLambdaTrafficShiftType.ALL_AT_ONCE:
            return codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
        case AppTheoryLambdaTrafficShiftType.LINEAR:
            return new codedeploy.LambdaDeploymentConfig(scope, "LinearDeploymentConfig", {
                trafficRouting: codedeploy.TrafficRouting.timeBasedLinear({
                    percentage: normalizedPercentage(options.percentage),
                    interval: options.interval ?? aws_cdk_lib_1.Duration.minutes(1),
                }),
            });
        case AppTheoryLambdaTrafficShiftType.CANARY:
            return new codedeploy.LambdaDeploymentConfig(scope, "CanaryDeploymentConfig", {
                trafficRouting: codedeploy.TrafficRouting.timeBasedCanary({
                    percentage: normalizedPercentage(options.percentage),
                    interval: options.interval ?? aws_cdk_lib_1.Duration.minutes(5),
                }),
            });
        default:
            throw new Error(`AppTheoryFunction unsupported deployment type: ${String(type)}`);
    }
}
function normalizedPercentage(input) {
    const value = input ?? 10;
    if (!Number.isFinite(value) || value <= 0 || value >= 100) {
        throw new Error("AppTheoryFunction deployment percentage must be greater than 0 and less than 100");
    }
    return value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmdW5jdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTZEO0FBRTdELHVFQUF5RDtBQUN6RCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUdwRTs7R0FFRztBQUNILElBQVksK0JBZVg7QUFmRCxXQUFZLCtCQUErQjtJQUN6Qzs7T0FFRztJQUNILDhEQUEyQixDQUFBO0lBRTNCOztPQUVHO0lBQ0gsb0RBQWlCLENBQUE7SUFFakI7O09BRUc7SUFDSCxvREFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBZlcsK0JBQStCLCtDQUEvQiwrQkFBK0IsUUFlMUM7QUFnSkQsTUFBYSxpQkFBa0IsU0FBUSxzQkFBUzs7SUFDOUIsRUFBRSxDQUFrQjtJQUNwQixRQUFRLENBQXFCO0lBQzdCLEtBQUssQ0FBZ0I7SUFDckIsZUFBZSxDQUFvQztJQUVuRSxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTZCO1FBQ3JFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsYUFBYSxFQUFFLFdBQVcsRUFBRSxHQUFHLGdCQUFnQixFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQ25GLE1BQU0sV0FBVyxHQUF5QixFQUFFLEdBQUcsZ0JBQWdCLEVBQUUsQ0FBQztRQUNsRSxNQUFNLE9BQU8sR0FBRyxXQUFXLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUEsaUNBQWtCLEVBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ3RGLElBQUksV0FBVyxDQUFDLElBQUksSUFBSSxRQUFRLEtBQUssU0FBUyxFQUFFLENBQUM7WUFD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TyxDQUFDLFVBQVUsQ0FBQztvQkFDcEQsUUFBUSxFQUFFLE9BQU8sQ0FBQyxRQUFRLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO2lCQUNsRCxDQUFDO2FBQ0gsQ0FBQyxDQUFDO1FBQ0w7WUFDRSxNQUFNLElBQUksS0FBSyxDQUFDLGtEQUFrRCxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxvQkFBb0IsQ0FBQyxLQUFjO0lBQzFDLE1BQU0sS0FBSyxHQUFHLEtBQUssSUFBSSxFQUFFLENBQUM7SUFDMUIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLElBQUksR0FBRyxFQUFFLENBQUM7UUFDMUQsTUFBTSxJQUFJLEtBQUssQ0FBQyxrRkFBa0YsQ0FBQyxDQUFDO0lBQ3RHLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoXCI7XG5pbXBvcnQgKiBhcyBjb2RlZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY29kZWRlcGxveVwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuLyoqXG4gKiBUcmFmZmljIHNoaWZ0aW5nIG1vZGUgZm9yIEFwcFRoZW9yeS1tYW5hZ2VkIExhbWJkYSBhbGlhc2VzLlxuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlIHtcbiAgLyoqXG4gICAqIFNoaWZ0IGFsbCB0cmFmZmljIHRvIHRoZSBuZXcgdmVyc2lvbiBhdCBvbmNlLlxuICAgKi9cbiAgQUxMX0FUX09OQ0UgPSBcIkFMTF9BVF9PTkNFXCIsXG5cbiAgLyoqXG4gICAqIFNoaWZ0IG9uZSBjYW5hcnkgaW5jcmVtZW50LCB3YWl0LCB0aGVuIHNoaWZ0IHRoZSByZW1haW5pbmcgdHJhZmZpYy5cbiAgICovXG4gIENBTkFSWSA9IFwiQ0FOQVJZXCIsXG5cbiAgLyoqXG4gICAqIFNoaWZ0IHRyYWZmaWMgaW4gZXF1YWwgbGluZWFyIGluY3JlbWVudHMuXG4gICAqL1xuICBMSU5FQVIgPSBcIkxJTkVBUlwiLFxufVxuXG4vKipcbiAqIENvZGVEZXBsb3kgZGVwbG95bWVudCBwcmVmZXJlbmNlcyBmb3IgYW4gQXBwVGhlb3J5IExhbWJkYSBhbGlhcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlGdW5jdGlvbkRlcGxveW1lbnRPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRyYWZmaWMgc2hpZnRpbmcgbW9kZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5DQU5BUllcbiAgICovXG4gIHJlYWRvbmx5IHRyYWZmaWNTaGlmdFR5cGU/OiBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlO1xuXG4gIC8qKlxuICAgKiBQZXJjZW50YWdlIHNoaWZ0ZWQgYXQgZWFjaCBjYW5hcnkgb3IgbGluZWFyIGluY3JlbWVudC5cbiAgICogQGRlZmF1bHQgMTBcbiAgICovXG4gIHJlYWRvbmx5IHBlcmNlbnRhZ2U/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRpbWUgYmV0d2VlbiB0cmFmZmljIHNoaWZ0cy5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcyg1KSBmb3IgY2FuYXJ5LCBEdXJhdGlvbi5taW51dGVzKDEpIGZvciBsaW5lYXJcbiAgICovXG4gIHJlYWRvbmx5IGludGVydmFsPzogRHVyYXRpb247XG5cbiAgLyoqXG4gICAqIENsb3VkV2F0Y2ggYWxhcm1zIHRoYXQgc3RvcCBhbmQgcm9sbCBiYWNrIGRlcGxveW1lbnRzLlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxhcm1zPzogY2xvdWR3YXRjaC5JQWxhcm1bXTtcblxuICAvKipcbiAgICogTGFtYmRhIHByZS10cmFmZmljIGhvb2suXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcHJlSG9vaz86IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIExhbWJkYSBwb3N0LXRyYWZmaWMgaG9vay5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBwb3N0SG9vaz86IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIENvZGVEZXBsb3kgYXV0by1yb2xsYmFjayBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCBDb2RlRGVwbG95IGRlZmF1bHRzXG4gICAqL1xuICByZWFkb25seSBhdXRvUm9sbGJhY2s/OiBjb2RlZGVwbG95LkF1dG9Sb2xsYmFja0NvbmZpZztcbn1cblxuLyoqXG4gKiBBbGlhcyBhbmQgcHJvdmlzaW9uZWQtY29uY3VycmVuY3kgb3B0aW9ucyBmb3IgYW4gQXBwVGhlb3J5IGZ1bmN0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUZ1bmN0aW9uQWxpYXNPcHRpb25zIHtcbiAgLyoqXG4gICAqIExhbWJkYSBhbGlhcyBuYW1lLlxuICAgKiBAZGVmYXVsdCBcImxpdmVcIlxuICAgKi9cbiAgcmVhZG9ubHkgbmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQWxpYXMgZGVzY3JpcHRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbmVkIGNvbmN1cnJlbmN5IGNvbmZpZ3VyZWQgb24gdGhlIGFsaWFzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHByb3Zpc2lvbmVkQ29uY3VycmVudEV4ZWN1dGlvbnM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIENvZGVEZXBsb3kgdHJhZmZpYyBzaGlmdGluZyBmb3IgdGhpcyBhbGlhcy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZXBsb3ltZW50PzogQXBwVGhlb3J5RnVuY3Rpb25EZXBsb3ltZW50T3B0aW9ucztcbn1cblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBhbiBBcHBUaGVvcnktbWFuYWdlZCBMYW1iZGEgZnVuY3Rpb24uXG4gKlxuICogQXBwVGhlb3J5IG92ZXJyaWRlcyB0aGUgaW5oZXJpdGVkIGBsb2dSZW1vdmFsUG9saWN5YCBkZWZhdWx0IGZvciBsb2cgZ3JvdXBzXG4gKiBpdCBjcmVhdGVzOiB0aGV5IHVzZSBgUmVtb3ZhbFBvbGljeS5SRVRBSU5gLCBzbyBkZWxldGluZyBhIHN0YWNrIHByZXNlcnZlc1xuICogdGhlIGV4ZWN1dGlvbiBsb2dzLiBQYXNzIGBSZW1vdmFsUG9saWN5LkRFU1RST1lgIGV4cGxpY2l0bHkgdG8gb3B0IGJhY2sgaW50b1xuICogdGhlIGRlc3RydWN0aXZlIGJlaGF2aW9yLiBDb21iaW5pbmcgYW4gZXhwbGljaXQgYGxvZ1JlbW92YWxQb2xpY3lgIHdpdGggYVxuICogY2FsbGVyLXByb3ZpZGVkIGBsb2dHcm91cGAgZmFpbHMgc3ludGhlc2lzIGJlY2F1c2UgY2FsbGVyLXByb3ZpZGVkIHJlc291cmNlc1xuICogb3duIHRoZWlyIHJlbW92YWwgcG9saWN5LlxuICpcbiAqIEJvdGggYGxvZ1JldGVudGlvbmAgYW5kIGBsb2dSZW1vdmFsUG9saWN5YCBhcmUgZGVwcmVjYXRlZCB1cHN0cmVhbSBpbiBmYXZvclxuICogb2YgYGxvZ0dyb3VwYCAoYEBkZXByZWNhdGVkIHVzZSBsb2dHcm91cCBpbnN0ZWFkYCBvbiB0aGUgaW5oZXJpdGVkIExhbWJkYSBMMlxuICogcHJvcHMpLiBUaGUgbWlncmF0aW9uIGlzIHRvIGNyZWF0ZSBhIGBsb2dzLkxvZ0dyb3VwYCB3aXRoIHRoZSBkZXNpcmVkXG4gKiBgcmV0ZW50aW9uYCBhbmQgYHJlbW92YWxQb2xpY3lgIGFuZCBwYXNzIGl0IGFzIGBsb2dHcm91cGA7IEFwcFRoZW9yeSB0aGVuXG4gKiB1c2VzIHRoYXQgZ3JvdXAgdW5jaGFuZ2VkLiBBbiBleHBsaWNpdCBgbG9nR3JvdXBgIHdpbnMgb3ZlciBgbG9nUmV0ZW50aW9uYCxcbiAqIGFuZCBjb21iaW5pbmcgaXQgd2l0aCBgbG9nUmVtb3ZhbFBvbGljeWAgZmFpbHMgc3ludGhlc2lzLlxuICpcbiAqIGpzaWkgZm9yYmlkcyByZS1kZWNsYXJpbmcgdGhlIGluaGVyaXRlZCBwcm9wcywgc28gdGhlIGRlcHJlY2F0aW9uIG5vdGljZSBpc1xuICogY2FycmllZCBieSB0aGUgYmFzZSBMYW1iZGEgTDIgaW50ZXJmYWNlIHJhdGhlciB0aGFuIHJlc3RhdGVkIGhlcmUuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RnVuY3Rpb25Qcm9wcyBleHRlbmRzIGxhbWJkYS5GdW5jdGlvblByb3BzIHtcbiAgLyoqXG4gICAqIFN0YWJsZSBwaHlzaWNhbCBuYW1lIGZvciB0aGUgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGV4ZWN1dGlvbiByb2xlLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgcHJlc2VydmVzIHRoZSBMYW1iZGEgTDIncyBwb2xpY2llcy4gQ29uY3JldGUgbmFtZXMgYXJlIHN5bnRoZXNpcy12YWxpZGF0ZWQgYWdhaW5zdCBJQU0ncyBgW1xcdys9LC5ALV0rYCBjaGFyYWN0ZXIgc2V0IGFuZCA2NC1jaGFyYWN0ZXIgbGltaXQuXG4gICAqIFRva2VuLXZhbHVlZCBuYW1lcyBhcmUgYWNjZXB0ZWQgYW5kIElBTSB2YWxpZGF0ZXMgdGhlIHJlc29sdmVkIHZhbHVlIGF0IGRlcGxveSB0aW1lLCBzbyBhbiBpbnZhbGlkIHJlc29sdmVkIG5hbWUgZmFpbHMgZGVwbG95bWVudCByYXRoZXIgdGhhbiBzeW50aGVzaXMuXG4gICAqIFRoaXMgZXhlbXB0aW9uIGtlZXBzIGFjY291bnQtYWdub3N0aWMgc3ludGhlc2lzIHJlcHJlc2VudGFibGUgZm9yIHRoZSBUSEUtMjg2MSB0b2tlbi12YWx1ZWQtaW5wdXQgZmFpbHVyZSBjbGFzcy4gRG8gbm90IGNvbWJpbmUgdGhpcyB3aXRoIHRoZSBpbmhlcml0ZWQgYHJvbGVgXG4gICAqIHByb3A7IGNhbGxlci1wcm92aWRlZCByb2xlcyBvd24gdGhlaXIgcGh5c2ljYWwgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb2xlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGFsaWFzLlxuICAgKlxuICAgKiBXaGVuIHNldCwgdGhlIGFsaWFzIHBvaW50cyBhdCB0aGUgZnVuY3Rpb24ncyBjdXJyZW50IHZlcnNpb24gYW5kIGNhbiBhbHNvXG4gICAqIGNhcnJ5IHByb3Zpc2lvbmVkIGNvbmN1cnJlbmN5IGFuZCBDb2RlRGVwbG95IHRyYWZmaWMgc2hpZnRpbmcuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYWxpYXM/OiBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggYSBkZXJpdmVkIG5hbWluZyBwcm9maWxlIHRoZSBjb25zdHJ1Y3QgbmFtZXMgdGhlIGZ1bmN0aW9uIGZyb20gdGhlXG4gICAqIGNvbnRyYWN0IHdoZW4gYGZ1bmN0aW9uTmFtZWAgaXMgb21pdHRlZC4gV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlXG4gICAqIEFwcFRoZW9yeSBjcmVhdGVzIGEgbG9nIGdyb3VwIG5hbWVkIGBsb2dzL3J1bnRpbWUve2xvZ2ljYWxOYW1lfWAgd2l0aCB0aGVcbiAgICogY29udGV4dCdzIHJldGVudGlvbiBhbmQgcG9pbnRzIExhbWJkYSdzIGBMb2dnaW5nQ29uZmlnYCBhdCBpdC5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBjb21wb25lbnQncyBsb2dpY2FsIG5hbWUsIHVzZWQgZm9yIHRoZSBmdW5jdGlvbiBhbmQgcnVudGltZSBsb2cgc291cmNlLlxuICAgKiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5RnVuY3Rpb24gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZm46IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXBSZWY7XG4gIHB1YmxpYyByZWFkb25seSBhbGlhcz86IGxhbWJkYS5BbGlhcztcbiAgcHVibGljIHJlYWRvbmx5IGRlcGxveW1lbnRHcm91cD86IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlGdW5jdGlvblByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgYWxpYXMsIHJvbGVOYW1lLCBuYW1pbmdDb250ZXh0LCBsb2dpY2FsTmFtZSwgLi4uaW5wdXRMYW1iZGFQcm9wcyB9ID0gcHJvcHM7XG4gICAgY29uc3QgbGFtYmRhUHJvcHM6IGxhbWJkYS5GdW5jdGlvblByb3BzID0geyAuLi5pbnB1dExhbWJkYVByb3BzIH07XG4gICAgY29uc3QgbG9naWNhbCA9IGxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICBpZiAobGFtYmRhUHJvcHMucm9sZSAmJiByb2xlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5RnVuY3Rpb24gY2Fubm90IGhvbm9yIHByb3BzLnJvbGVOYW1lIHdoZW4gcHJvcHMucm9sZSBzdXBwbGllcyB0aGUgZXhlY3V0aW9uIHJvbGU7IG9taXQgcHJvcHMucm9sZSBvciBjb25maWd1cmUgaXRzIG5hbWUgd2hlcmUgdGhhdCByb2xlIGlzIGNyZWF0ZWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeUZ1bmN0aW9uXCIsIFwiZnVuY3Rpb25OYW1lXCIsIFwibGFtYmRhX2Z1bmN0aW9uXCIsIGxvZ2ljYWwsIGxhbWJkYVByb3BzLmZ1bmN0aW9uTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlGdW5jdGlvblwiLCBcInJvbGVOYW1lXCIsIFwiaWFtX3JvbGVcIiwgbG9naWNhbCwgcm9sZU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgbG9nUmV0ZW50aW9uID0gbGFtYmRhUHJvcHMubG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEg7XG4gICAgY29uc3QgcmVxdWVzdGVkTG9nUmVtb3ZhbFBvbGljeSA9IGxhbWJkYVByb3BzLmxvZ1JlbW92YWxQb2xpY3k7XG4gICAgaWYgKGxhbWJkYVByb3BzLmxvZ0dyb3VwICYmIHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBob25vciBwcm9wcy5sb2dSZW1vdmFsUG9saWN5IHdoZW4gcHJvcHMubG9nR3JvdXAgc3VwcGxpZXMgdGhlIGxvZyBncm91cDsgb21pdCBwcm9wcy5sb2dSZW1vdmFsUG9saWN5IG9yIGNvbmZpZ3VyZSB0aGUgcmVtb3ZhbCBwb2xpY3kgd2hlcmUgdGhhdCBsb2cgZ3JvdXAgaXMgY3JlYXRlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cyB9KS5sb2dSZXRlbnRpb247XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JlbW92YWxQb2xpY3k/OiB1bmtub3duIH0pLmxvZ1JlbW92YWxQb2xpY3k7XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JldGVudGlvblJldHJ5T3B0aW9ucz86IHVua25vd24gfSkubG9nUmV0ZW50aW9uUmV0cnlPcHRpb25zO1xuICAgIGRlbGV0ZSAobGFtYmRhUHJvcHMgYXMgeyBsb2dSZXRlbnRpb25Sb2xlPzogdW5rbm93biB9KS5sb2dSZXRlbnRpb25Sb2xlO1xuXG4gICAgbGV0IGVmZmVjdGl2ZVJvbGVOYW1lID0gcm9sZU5hbWU7XG4gICAgaWYgKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgY29uc3QgY29tcG9zZWQgPSBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImxhbWJkYV9mdW5jdGlvblwiLCBsb2dpY2FsKTtcbiAgICAgIGlmICghY29tcG9zZWQuZ2VuZXJhdGVkKSB7XG4gICAgICAgIChsYW1iZGFQcm9wcyBhcyB7IGZ1bmN0aW9uTmFtZT86IHN0cmluZyB9KS5mdW5jdGlvbk5hbWUgPSBjb21wb3NlZC5uYW1lO1xuICAgICAgfVxuICAgICAgaWYgKCFsYW1iZGFQcm9wcy5yb2xlKSB7XG4gICAgICAgIGNvbnN0IHJvbGUgPSBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImlhbV9yb2xlXCIsIGxvZ2ljYWwpO1xuICAgICAgICBlZmZlY3RpdmVSb2xlTmFtZSA9IHJvbGUuZ2VuZXJhdGVkID8gdW5kZWZpbmVkIDogcm9sZS5uYW1lO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBib3VuZExvZ0dyb3VwID0gbGFtYmRhUHJvcHMubG9nR3JvdXA7XG4gICAgY29uc3Qgc3RhbmRhcmRMb2dnaW5nID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgIGlmIChzdGFuZGFyZExvZ2dpbmcpIHtcbiAgICAgIGlmIChsYW1iZGFQcm9wcy5sb2dHcm91cCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgY29tYmluZSBwcm9wcy5sb2dHcm91cCB3aXRoIGEgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlOyB0aGUgcHJvZmlsZSBvd25zIHRoZSBydW50aW1lIGxvZyBncm91cFwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFuYW1pbmdDb250ZXh0IHx8ICFsb2dpY2FsKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUZ1bmN0aW9uIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBuYW1pbmcgY29udGV4dCBhbmQgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICB9XG4gICAgICBib3VuZExvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJSdW50aW1lTG9nR3JvdXBcIiwge1xuICAgICAgICBsb2dHcm91cE5hbWU6IG5hbWluZ0NvbnRleHQubG9nR3JvdXBOYW1lKGBsb2dzL3J1bnRpbWUvJHtsb2dpY2FsfWApLFxuICAgICAgICByZXRlbnRpb246IG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyBhcyBsb2dzLlJldGVudGlvbkRheXMsXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKCFib3VuZExvZ0dyb3VwICYmICFzdGFuZGFyZExvZ2dpbmcgJiYgbGFtYmRhUHJvcHMuZnVuY3Rpb25OYW1lKSB7XG4gICAgICBib3VuZExvZ0dyb3VwID0gY3JlYXRlTWFuYWdlZEZ1bmN0aW9uTG9nR3JvdXAoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGAvYXdzL2xhbWJkYS8ke2xhbWJkYVByb3BzLmZ1bmN0aW9uTmFtZX1gLFxuICAgICAgICBsb2dSZXRlbnRpb24sXG4gICAgICAgIHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICApO1xuICAgIH1cblxuICAgIHRoaXMuZm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiRnVuY3Rpb25cIiwge1xuICAgICAgLi4ubGFtYmRhUHJvcHMsXG4gICAgICBsb2dHcm91cDogYm91bmRMb2dHcm91cCxcbiAgICAgIGFyY2hpdGVjdHVyZTogbGFtYmRhUHJvcHMuYXJjaGl0ZWN0dXJlID8/IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgdHJhY2luZzogbGFtYmRhUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBsYW1iZGFQcm9wcy5tZW1vcnlTaXplID8/IDI1NixcbiAgICAgIHRpbWVvdXQ6IGxhbWJkYVByb3BzLnRpbWVvdXQgPz8gRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgfSk7XG5cbiAgICBpZiAoZWZmZWN0aXZlUm9sZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoZWZmZWN0aXZlUm9sZU5hbWUpKSB7XG4gICAgICAgIGlmICghZWZmZWN0aXZlUm9sZU5hbWUudHJpbSgpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGVmZmVjdGl2ZVJvbGVOYW1lLmxlbmd0aCA+IDY0KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBub3QgZXhjZWVkIDY0IGNoYXJhY3RlcnNcIik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCEvXltcXHcrPSwuQC1dKyQvLnRlc3QoZWZmZWN0aXZlUm9sZU5hbWUpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBtYXRjaCBbXFxcXHcrPSwuQC1dK1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3Qgcm9sZVJlc291cmNlID0gdGhpcy5mbi5yb2xlPy5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgICAgIGlmICghKHJvbGVSZXNvdXJjZSBpbnN0YW5jZW9mIGlhbS5DZm5Sb2xlKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBhcHBseSB0aGUgcmVxdWlyZWQgc3RhYmxlIHJvbGVOYW1lICR7SlNPTi5zdHJpbmdpZnkoZWZmZWN0aXZlUm9sZU5hbWUpfSBiZWNhdXNlIHRoZSBMYW1iZGEgZXhlY3V0aW9uIHJvbGUncyBkZWZhdWx0IGNoaWxkIGlzIG5vdCBhbiBBV1M6OklBTTo6Um9sZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByb2xlUmVzb3VyY2UuYWRkUHJvcGVydHlPdmVycmlkZShcIlJvbGVOYW1lXCIsIGVmZmVjdGl2ZVJvbGVOYW1lKTtcbiAgICB9XG5cbiAgICBpZiAoYm91bmRMb2dHcm91cCkge1xuICAgICAgKHRoaXMgYXMgeyBsb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwUmVmIH0pLmxvZ0dyb3VwID0gYm91bmRMb2dHcm91cDtcbiAgICAgIGlmIChzdGFuZGFyZExvZ2dpbmcpIHtcbiAgICAgICAgKGJvdW5kTG9nR3JvdXAgYXMgbG9ncy5JTG9nR3JvdXApLmdyYW50V3JpdGUodGhpcy5mbik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEFub255bW91cyBMYW1iZGEgcGh5c2ljYWwgbmFtZXMgYXJlIGdlbmVyYXRlZCBieSBDbG91ZEZvcm1hdGlvbi4gS2VlcFxuICAgICAgLy8gdGhlIGZpbml0ZS1yZXRlbnRpb24gbG9nIGdyb3VwLCBidXQgcmVxdWlyZSBjYWxsZXJzIHRoYXQgbmVlZCBhXG4gICAgICAvLyBmYWlsLXNhZmUgZXhpc3Rpbmctc3RhY2sgdXBncmFkZS9hZG9wdGlvbiBwYXRoIHRvIHBhc3MgbG9nR3JvdXAgb3IgYVxuICAgICAgLy8gY29uY3JldGUgZnVuY3Rpb25OYW1lIHNvIHRoZSBMYW1iZGEgTDIgY2FuIGJpbmQgdGhlIGdyb3VwIHVwIGZyb250LlxuICAgICAgY29uc3QgbG9nR3JvdXAgPSBjcmVhdGVNYW5hZ2VkRnVuY3Rpb25Mb2dHcm91cChcbiAgICAgICAgdGhpcyxcbiAgICAgICAgYC9hd3MvbGFtYmRhLyR7dGhpcy5mbi5mdW5jdGlvbk5hbWV9YCxcbiAgICAgICAgbG9nUmV0ZW50aW9uLFxuICAgICAgICByZXF1ZXN0ZWRMb2dSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgKTtcbiAgICAgICh0aGlzIGFzIHsgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cFJlZiB9KS5sb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgIH1cblxuICAgIGlmIChhbGlhcykge1xuICAgICAgdGhpcy5jb25maWd1cmVBbGlhcyhhbGlhcyk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVBbGlhcyhvcHRpb25zOiBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucyk6IHZvaWQge1xuICAgIGNvbnN0IGFsaWFzTmFtZSA9IFN0cmluZyhvcHRpb25zLm5hbWUgPz8gXCJsaXZlXCIpLnRyaW0oKTtcbiAgICBpZiAoIWFsaWFzTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gYWxpYXMubmFtZSBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBhbGlhcyA9IG5ldyBsYW1iZGEuQWxpYXModGhpcywgXCJBbGlhc1wiLCB7XG4gICAgICBhbGlhc05hbWUsXG4gICAgICB2ZXJzaW9uOiB0aGlzLmZuLmN1cnJlbnRWZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IG9wdGlvbnMuZGVzY3JpcHRpb24sXG4gICAgICBwcm92aXNpb25lZENvbmN1cnJlbnRFeGVjdXRpb25zOiBvcHRpb25zLnByb3Zpc2lvbmVkQ29uY3VycmVudEV4ZWN1dGlvbnMsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhbGlhcz86IGxhbWJkYS5BbGlhcyB9KS5hbGlhcyA9IGFsaWFzO1xuXG4gICAgaWYgKG9wdGlvbnMuZGVwbG95bWVudCkge1xuICAgICAgY29uc3QgZGVwbG95bWVudEdyb3VwID0gbmV3IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwKHRoaXMsIFwiRGVwbG95bWVudEdyb3VwXCIsIHtcbiAgICAgICAgYWxpYXMsXG4gICAgICAgIGRlcGxveW1lbnRDb25maWc6IGRlcGxveW1lbnRDb25maWdGb3IodGhpcywgb3B0aW9ucy5kZXBsb3ltZW50KSxcbiAgICAgICAgYWxhcm1zOiBvcHRpb25zLmRlcGxveW1lbnQuYWxhcm1zLFxuICAgICAgICBwcmVIb29rOiBvcHRpb25zLmRlcGxveW1lbnQucHJlSG9vayxcbiAgICAgICAgcG9zdEhvb2s6IG9wdGlvbnMuZGVwbG95bWVudC5wb3N0SG9vayxcbiAgICAgICAgYXV0b1JvbGxiYWNrOiBvcHRpb25zLmRlcGxveW1lbnQuYXV0b1JvbGxiYWNrLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGRlcGxveW1lbnRHcm91cD86IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwIH0pLmRlcGxveW1lbnRHcm91cCA9IGRlcGxveW1lbnRHcm91cDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlTWFuYWdlZEZ1bmN0aW9uTG9nR3JvdXAoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGxvZ0dyb3VwTmFtZTogc3RyaW5nLFxuICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cyxcbiAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeSxcbik6IGxvZ3MuTG9nR3JvdXAge1xuICBpZiAocmVtb3ZhbFBvbGljeSA9PT0gUmVtb3ZhbFBvbGljeS5TTkFQU0hPVCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5RnVuY3Rpb24gY2Fubm90IGFwcGx5IFJlbW92YWxQb2xpY3kuU05BUFNIT1QgYmVjYXVzZSBBV1M6OkxvZ3M6OkxvZ0dyb3VwIGRvZXMgbm90IHN1cHBvcnQgc25hcHNob3QgcmVtb3ZhbCBwb2xpY2llc1wiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHNjb3BlLCBcIkxvZ0dyb3VwXCIsIHtcbiAgICBsb2dHcm91cE5hbWUsXG4gICAgcmV0ZW50aW9uLFxuICB9KTtcblxuICBjb25zdCBsb2dHcm91cFJlc291cmNlID0gbG9nR3JvdXAubm9kZS5kZWZhdWx0Q2hpbGQ7XG4gIGlmICghKGxvZ0dyb3VwUmVzb3VyY2UgaW5zdGFuY2VvZiBsb2dzLkNmbkxvZ0dyb3VwKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgYXBwbHkgbG9nUmVtb3ZhbFBvbGljeSAke0pTT04uc3RyaW5naWZ5KHJlbW92YWxQb2xpY3kpfSBiZWNhdXNlIHRoZSBBcHBUaGVvcnktbWFuYWdlZCBsb2cgZ3JvdXAncyBkZWZhdWx0IGNoaWxkIGlzIG5vdCBhbiBBV1M6OkxvZ3M6OkxvZ0dyb3VwYCxcbiAgICApO1xuICB9XG4gIGxvZ0dyb3VwUmVzb3VyY2UuYXBwbHlSZW1vdmFsUG9saWN5KHJlbW92YWxQb2xpY3kpO1xuXG4gIHJldHVybiBsb2dHcm91cDtcbn1cblxuZnVuY3Rpb24gZGVwbG95bWVudENvbmZpZ0ZvcihzY29wZTogQ29uc3RydWN0LCBvcHRpb25zOiBBcHBUaGVvcnlGdW5jdGlvbkRlcGxveW1lbnRPcHRpb25zKTogY29kZWRlcGxveS5JTGFtYmRhRGVwbG95bWVudENvbmZpZyB7XG4gIGNvbnN0IHR5cGUgPSBvcHRpb25zLnRyYWZmaWNTaGlmdFR5cGUgPz8gQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5DQU5BUlk7XG4gIHN3aXRjaCAodHlwZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5BTExfQVRfT05DRTpcbiAgICAgIHJldHVybiBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRDb25maWcuQUxMX0FUX09OQ0U7XG4gICAgY2FzZSBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkxJTkVBUjpcbiAgICAgIHJldHVybiBuZXcgY29kZWRlcGxveS5MYW1iZGFEZXBsb3ltZW50Q29uZmlnKHNjb3BlLCBcIkxpbmVhckRlcGxveW1lbnRDb25maWdcIiwge1xuICAgICAgICB0cmFmZmljUm91dGluZzogY29kZWRlcGxveS5UcmFmZmljUm91dGluZy50aW1lQmFzZWRMaW5lYXIoe1xuICAgICAgICAgIHBlcmNlbnRhZ2U6IG5vcm1hbGl6ZWRQZXJjZW50YWdlKG9wdGlvbnMucGVyY2VudGFnZSksXG4gICAgICAgICAgaW50ZXJ2YWw6IG9wdGlvbnMuaW50ZXJ2YWwgPz8gRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgICAgfSksXG4gICAgICB9KTtcbiAgICBjYXNlIEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGUuQ0FOQVJZOlxuICAgICAgcmV0dXJuIG5ldyBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRDb25maWcoc2NvcGUsIFwiQ2FuYXJ5RGVwbG95bWVudENvbmZpZ1wiLCB7XG4gICAgICAgIHRyYWZmaWNSb3V0aW5nOiBjb2RlZGVwbG95LlRyYWZmaWNSb3V0aW5nLnRpbWVCYXNlZENhbmFyeSh7XG4gICAgICAgICAgcGVyY2VudGFnZTogbm9ybWFsaXplZFBlcmNlbnRhZ2Uob3B0aW9ucy5wZXJjZW50YWdlKSxcbiAgICAgICAgICBpbnRlcnZhbDogb3B0aW9ucy5pbnRlcnZhbCA/PyBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeUZ1bmN0aW9uIHVuc3VwcG9ydGVkIGRlcGxveW1lbnQgdHlwZTogJHtTdHJpbmcodHlwZSl9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplZFBlcmNlbnRhZ2UoaW5wdXQ/OiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCB2YWx1ZSA9IGlucHV0ID8/IDEwO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCB8fCB2YWx1ZSA+PSAxMDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlGdW5jdGlvbiBkZXBsb3ltZW50IHBlcmNlbnRhZ2UgbXVzdCBiZSBncmVhdGVyIHRoYW4gMCBhbmQgbGVzcyB0aGFuIDEwMFwiKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG4iXX0=