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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunction", version: "5.0.2" };
    fn;
    logGroup;
    alias;
    deploymentGroup;
    constructor(scope, id, props) {
        super(scope, id);
        const { alias, roleName, ...inputLambdaProps } = props;
        const lambdaProps = { ...inputLambdaProps };
        if (roleName !== undefined) {
            if (lambdaProps.role) {
                throw new Error("AppTheoryFunction cannot honor props.roleName when props.role supplies the execution role; omit props.role or configure its name where that role is created");
            }
        }
        const logRetention = lambdaProps.logRetention ?? logs.RetentionDays.ONE_MONTH;
        const requestedLogRemovalPolicy = lambdaProps.logRemovalPolicy;
        if (lambdaProps.logGroup && requestedLogRemovalPolicy !== undefined) {
            throw new Error("AppTheoryFunction cannot honor props.logRemovalPolicy when props.logGroup supplies the log group; omit props.logRemovalPolicy or configure the removal policy where that log group is created");
        }
        delete lambdaProps.logRetention;
        delete lambdaProps.logRemovalPolicy;
        delete lambdaProps.logRetentionRetryOptions;
        delete lambdaProps.logRetentionRole;
        let boundLogGroup = lambdaProps.logGroup;
        if (!boundLogGroup && lambdaProps.functionName) {
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
        if (roleName !== undefined) {
            if (!aws_cdk_lib_1.Token.isUnresolved(roleName)) {
                if (!roleName.trim()) {
                    throw new Error("AppTheoryFunction roleName must not be empty");
                }
                if (roleName.length > 64) {
                    throw new Error("AppTheoryFunction roleName must not exceed 64 characters");
                }
                if (!/^[\w+=,.@-]+$/.test(roleName)) {
                    throw new Error("AppTheoryFunction roleName must match [\\w+=,.@-]+");
                }
            }
            const roleResource = this.fn.role?.node.defaultChild;
            if (!(roleResource instanceof iam.CfnRole)) {
                throw new Error(`AppTheoryFunction cannot apply the required stable roleName ${JSON.stringify(roleName)} because the Lambda execution role's default child is not an AWS::IAM::Role`);
            }
            roleResource.addPropertyOverride("RoleName", roleName);
        }
        if (boundLogGroup) {
            this.logGroup = boundLogGroup;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmdW5jdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTZEO0FBRTdELHVFQUF5RDtBQUN6RCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkM7O0dBRUc7QUFDSCxJQUFZLCtCQWVYO0FBZkQsV0FBWSwrQkFBK0I7SUFDekM7O09BRUc7SUFDSCw4REFBMkIsQ0FBQTtJQUUzQjs7T0FFRztJQUNILG9EQUFpQixDQUFBO0lBRWpCOztPQUVHO0lBQ0gsb0RBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQWZXLCtCQUErQiwrQ0FBL0IsK0JBQStCLFFBZTFDO0FBZ0hELE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzlCLEVBQUUsQ0FBa0I7SUFDcEIsUUFBUSxDQUFxQjtJQUM3QixLQUFLLENBQWdCO0lBQ3JCLGVBQWUsQ0FBb0M7SUFFbkUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE2QjtRQUNyRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLEdBQUcsZ0JBQWdCLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDdkQsTUFBTSxXQUFXLEdBQXlCLEVBQUUsR0FBRyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ2xFLElBQUksUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLElBQUksV0FBVyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNyQixNQUFNLElBQUksS0FBSyxDQUNiLDZKQUE2SixDQUM5SixDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7UUFDRCxNQUFNLFlBQVksR0FBRyxXQUFXLENBQUMsWUFBWSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQzlFLE1BQU0s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b3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoXCI7XG5pbXBvcnQgKiBhcyBjb2RlZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY29kZWRlcGxveVwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIFRyYWZmaWMgc2hpZnRpbmcgbW9kZSBmb3IgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGFsaWFzZXMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGUge1xuICAvKipcbiAgICogU2hpZnQgYWxsIHRyYWZmaWMgdG8gdGhlIG5ldyB2ZXJzaW9uIGF0IG9uY2UuXG4gICAqL1xuICBBTExfQVRfT05DRSA9IFwiQUxMX0FUX09OQ0VcIixcblxuICAvKipcbiAgICogU2hpZnQgb25lIGNhbmFyeSBpbmNyZW1lbnQsIHdhaXQsIHRoZW4gc2hpZnQgdGhlIHJlbWFpbmluZyB0cmFmZmljLlxuICAgKi9cbiAgQ0FOQVJZID0gXCJDQU5BUllcIixcblxuICAvKipcbiAgICogU2hpZnQgdHJhZmZpYyBpbiBlcXVhbCBsaW5lYXIgaW5jcmVtZW50cy5cbiAgICovXG4gIExJTkVBUiA9IFwiTElORUFSXCIsXG59XG5cbi8qKlxuICogQ29kZURlcGxveSBkZXBsb3ltZW50IHByZWZlcmVuY2VzIGZvciBhbiBBcHBUaGVvcnkgTGFtYmRhIGFsaWFzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUZ1bmN0aW9uRGVwbG95bWVudE9wdGlvbnMge1xuICAvKipcbiAgICogVHJhZmZpYyBzaGlmdGluZyBtb2RlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkNBTkFSWVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhZmZpY1NoaWZ0VHlwZT86IEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGU7XG5cbiAgLyoqXG4gICAqIFBlcmNlbnRhZ2Ugc2hpZnRlZCBhdCBlYWNoIGNhbmFyeSBvciBsaW5lYXIgaW5jcmVtZW50LlxuICAgKiBAZGVmYXVsdCAxMFxuICAgKi9cbiAgcmVhZG9ubHkgcGVyY2VudGFnZT86IG51bWJlcjtcblxuICAvKipcbiAgICogVGltZSBiZXR3ZWVuIHRyYWZmaWMgc2hpZnRzLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDUpIGZvciBjYW5hcnksIER1cmF0aW9uLm1pbnV0ZXMoMSkgZm9yIGxpbmVhclxuICAgKi9cbiAgcmVhZG9ubHkgaW50ZXJ2YWw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogQ2xvdWRXYXRjaCBhbGFybXMgdGhhdCBzdG9wIGFuZCByb2xsIGJhY2sgZGVwbG95bWVudHMuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBhbGFybXM/OiBjbG91ZHdhdGNoLklBbGFybVtdO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcHJlLXRyYWZmaWMgaG9vay5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBwcmVIb29rPzogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogTGFtYmRhIHBvc3QtdHJhZmZpYyBob29rLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHBvc3RIb29rPzogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogQ29kZURlcGxveSBhdXRvLXJvbGxiYWNrIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IENvZGVEZXBsb3kgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IGF1dG9Sb2xsYmFjaz86IGNvZGVkZXBsb3kuQXV0b1JvbGxiYWNrQ29uZmlnO1xufVxuXG4vKipcbiAqIEFsaWFzIGFuZCBwcm92aXNpb25lZC1jb25jdXJyZW5jeSBvcHRpb25zIGZvciBhbiBBcHBUaGVvcnkgZnVuY3Rpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RnVuY3Rpb25BbGlhc09wdGlvbnMge1xuICAvKipcbiAgICogTGFtYmRhIGFsaWFzIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwibGl2ZVwiXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBbGlhcyBkZXNjcmlwdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgY29uY3VycmVuY3kgY29uZmlndXJlZCBvbiB0aGUgYWxpYXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcHJvdmlzaW9uZWRDb25jdXJyZW50RXhlY3V0aW9ucz86IG51bWJlcjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ29kZURlcGxveSB0cmFmZmljIHNoaWZ0aW5nIGZvciB0aGlzIGFsaWFzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRlcGxveW1lbnQ/OiBBcHBUaGVvcnlGdW5jdGlvbkRlcGxveW1lbnRPcHRpb25zO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIEFwcFRoZW9yeS1tYW5hZ2VkIExhbWJkYSBmdW5jdGlvbi5cbiAqXG4gKiBBcHBUaGVvcnkgb3ZlcnJpZGVzIHRoZSBpbmhlcml0ZWQgYGxvZ1JlbW92YWxQb2xpY3lgIGRlZmF1bHQgZm9yIGxvZyBncm91cHNcbiAqIGl0IGNyZWF0ZXM6IHRoZXkgdXNlIGBSZW1vdmFsUG9saWN5LlJFVEFJTmAsIHNvIGRlbGV0aW5nIGEgc3RhY2sgcHJlc2VydmVzXG4gKiB0aGUgZXhlY3V0aW9uIGxvZ3MuIFBhc3MgYFJlbW92YWxQb2xpY3kuREVTVFJPWWAgZXhwbGljaXRseSB0byBvcHQgYmFjayBpbnRvXG4gKiB0aGUgZGVzdHJ1Y3RpdmUgYmVoYXZpb3IuIENvbWJpbmluZyBhbiBleHBsaWNpdCBgbG9nUmVtb3ZhbFBvbGljeWAgd2l0aCBhXG4gKiBjYWxsZXItcHJvdmlkZWQgYGxvZ0dyb3VwYCBmYWlscyBzeW50aGVzaXMgYmVjYXVzZSBjYWxsZXItcHJvdmlkZWQgcmVzb3VyY2VzXG4gKiBvd24gdGhlaXIgcmVtb3ZhbCBwb2xpY3kuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RnVuY3Rpb25Qcm9wcyBleHRlbmRzIGxhbWJkYS5GdW5jdGlvblByb3BzIHtcbiAgLyoqXG4gICAqIFN0YWJsZSBwaHlzaWNhbCBuYW1lIGZvciB0aGUgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGV4ZWN1dGlvbiByb2xlLlxuICAgKlxuICAgKiBBcHBUaGVvcnkgcHJlc2VydmVzIHRoZSBMYW1iZGEgTDIncyBwb2xpY2llcy4gQ29uY3JldGUgbmFtZXMgYXJlIHN5bnRoZXNpcy12YWxpZGF0ZWQgYWdhaW5zdCBJQU0ncyBgW1xcdys9LC5ALV0rYCBjaGFyYWN0ZXIgc2V0IGFuZCA2NC1jaGFyYWN0ZXIgbGltaXQuXG4gICAqIFRva2VuLXZhbHVlZCBuYW1lcyBhcmUgYWNjZXB0ZWQgYW5kIElBTSB2YWxpZGF0ZXMgdGhlIHJlc29sdmVkIHZhbHVlIGF0IGRlcGxveSB0aW1lLCBzbyBhbiBpbnZhbGlkIHJlc29sdmVkIG5hbWUgZmFpbHMgZGVwbG95bWVudCByYXRoZXIgdGhhbiBzeW50aGVzaXMuXG4gICAqIFRoaXMgZXhlbXB0aW9uIGtlZXBzIGFjY291bnQtYWdub3N0aWMgc3ludGhlc2lzIHJlcHJlc2VudGFibGUgZm9yIHRoZSBUSEUtMjg2MSB0b2tlbi12YWx1ZWQtaW5wdXQgZmFpbHVyZSBjbGFzcy4gRG8gbm90IGNvbWJpbmUgdGhpcyB3aXRoIHRoZSBpbmhlcml0ZWQgYHJvbGVgXG4gICAqIHByb3A7IGNhbGxlci1wcm92aWRlZCByb2xlcyBvd24gdGhlaXIgcGh5c2ljYWwgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb2xlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGFsaWFzLlxuICAgKlxuICAgKiBXaGVuIHNldCwgdGhlIGFsaWFzIHBvaW50cyBhdCB0aGUgZnVuY3Rpb24ncyBjdXJyZW50IHZlcnNpb24gYW5kIGNhbiBhbHNvXG4gICAqIGNhcnJ5IHByb3Zpc2lvbmVkIGNvbmN1cnJlbmN5IGFuZCBDb2RlRGVwbG95IHRyYWZmaWMgc2hpZnRpbmcuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYWxpYXM/OiBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUZ1bmN0aW9uIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGZuOiBsYW1iZGEuRnVuY3Rpb247XG4gIHB1YmxpYyByZWFkb25seSBsb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwUmVmO1xuICBwdWJsaWMgcmVhZG9ubHkgYWxpYXM/OiBsYW1iZGEuQWxpYXM7XG4gIHB1YmxpYyByZWFkb25seSBkZXBsb3ltZW50R3JvdXA/OiBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RnVuY3Rpb25Qcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCB7IGFsaWFzLCByb2xlTmFtZSwgLi4uaW5wdXRMYW1iZGFQcm9wcyB9ID0gcHJvcHM7XG4gICAgY29uc3QgbGFtYmRhUHJvcHM6IGxhbWJkYS5GdW5jdGlvblByb3BzID0geyAuLi5pbnB1dExhbWJkYVByb3BzIH07XG4gICAgaWYgKHJvbGVOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChsYW1iZGFQcm9wcy5yb2xlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcIkFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBob25vciBwcm9wcy5yb2xlTmFtZSB3aGVuIHByb3BzLnJvbGUgc3VwcGxpZXMgdGhlIGV4ZWN1dGlvbiByb2xlOyBvbWl0IHByb3BzLnJvbGUgb3IgY29uZmlndXJlIGl0cyBuYW1lIHdoZXJlIHRoYXQgcm9sZSBpcyBjcmVhdGVkXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGxvZ1JldGVudGlvbiA9IGxhbWJkYVByb3BzLmxvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIO1xuICAgIGNvbnN0IHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgPSBsYW1iZGFQcm9wcy5sb2dSZW1vdmFsUG9saWN5O1xuICAgIGlmIChsYW1iZGFQcm9wcy5sb2dHcm91cCAmJiByZXF1ZXN0ZWRMb2dSZW1vdmFsUG9saWN5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgaG9ub3IgcHJvcHMubG9nUmVtb3ZhbFBvbGljeSB3aGVuIHByb3BzLmxvZ0dyb3VwIHN1cHBsaWVzIHRoZSBsb2cgZ3JvdXA7IG9taXQgcHJvcHMubG9nUmVtb3ZhbFBvbGljeSBvciBjb25maWd1cmUgdGhlIHJlbW92YWwgcG9saWN5IHdoZXJlIHRoYXQgbG9nIGdyb3VwIGlzIGNyZWF0ZWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGRlbGV0ZSAobGFtYmRhUHJvcHMgYXMgeyBsb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXMgfSkubG9nUmV0ZW50aW9uO1xuICAgIGRlbGV0ZSAobGFtYmRhUHJvcHMgYXMgeyBsb2dSZW1vdmFsUG9saWN5PzogdW5rbm93biB9KS5sb2dSZW1vdmFsUG9saWN5O1xuICAgIGRlbGV0ZSAobGFtYmRhUHJvcHMgYXMgeyBsb2dSZXRlbnRpb25SZXRyeU9wdGlvbnM/OiB1bmtub3duIH0pLmxvZ1JldGVudGlvblJldHJ5T3B0aW9ucztcbiAgICBkZWxldGUgKGxhbWJkYVByb3BzIGFzIHsgbG9nUmV0ZW50aW9uUm9sZT86IHVua25vd24gfSkubG9nUmV0ZW50aW9uUm9sZTtcblxuICAgIGxldCBib3VuZExvZ0dyb3VwID0gbGFtYmRhUHJvcHMubG9nR3JvdXA7XG4gICAgaWYgKCFib3VuZExvZ0dyb3VwICYmIGxhbWJkYVByb3BzLmZ1bmN0aW9uTmFtZSkge1xuICAgICAgYm91bmRMb2dHcm91cCA9IGNyZWF0ZU1hbmFnZWRGdW5jdGlvbkxvZ0dyb3VwKFxuICAgICAgICB0aGlzLFxuICAgICAgICBgL2F3cy9sYW1iZGEvJHtsYW1iZGFQcm9wcy5mdW5jdGlvbk5hbWV9YCxcbiAgICAgICAgbG9nUmV0ZW50aW9uLFxuICAgICAgICByZXF1ZXN0ZWRMb2dSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLmZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkZ1bmN0aW9uXCIsIHtcbiAgICAgIC4uLmxhbWJkYVByb3BzLFxuICAgICAgbG9nR3JvdXA6IGJvdW5kTG9nR3JvdXAsXG4gICAgICBhcmNoaXRlY3R1cmU6IGxhbWJkYVByb3BzLmFyY2hpdGVjdHVyZSA/PyBsYW1iZGEuQXJjaGl0ZWN0dXJlLkFSTV82NCxcbiAgICAgIHRyYWNpbmc6IGxhbWJkYVByb3BzLnRyYWNpbmcgPz8gbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgbWVtb3J5U2l6ZTogbGFtYmRhUHJvcHMubWVtb3J5U2l6ZSA/PyAyNTYsXG4gICAgICB0aW1lb3V0OiBsYW1iZGFQcm9wcy50aW1lb3V0ID8/IER1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgIH0pO1xuXG4gICAgaWYgKHJvbGVOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJvbGVOYW1lKSkge1xuICAgICAgICBpZiAoIXJvbGVOYW1lLnRyaW0oKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUZ1bmN0aW9uIHJvbGVOYW1lIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyb2xlTmFtZS5sZW5ndGggPiA2NCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUZ1bmN0aW9uIHJvbGVOYW1lIG11c3Qgbm90IGV4Y2VlZCA2NCBjaGFyYWN0ZXJzXCIpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghL15bXFx3Kz0sLkAtXSskLy50ZXN0KHJvbGVOYW1lKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUZ1bmN0aW9uIHJvbGVOYW1lIG11c3QgbWF0Y2ggW1xcXFx3Kz0sLkAtXStcIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IHJvbGVSZXNvdXJjZSA9IHRoaXMuZm4ucm9sZT8ubm9kZS5kZWZhdWx0Q2hpbGQ7XG4gICAgICBpZiAoIShyb2xlUmVzb3VyY2UgaW5zdGFuY2VvZiBpYW0uQ2ZuUm9sZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgYXBwbHkgdGhlIHJlcXVpcmVkIHN0YWJsZSByb2xlTmFtZSAke0pTT04uc3RyaW5naWZ5KHJvbGVOYW1lKX0gYmVjYXVzZSB0aGUgTGFtYmRhIGV4ZWN1dGlvbiByb2xlJ3MgZGVmYXVsdCBjaGlsZCBpcyBub3QgYW4gQVdTOjpJQU06OlJvbGVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcm9sZVJlc291cmNlLmFkZFByb3BlcnR5T3ZlcnJpZGUoXCJSb2xlTmFtZVwiLCByb2xlTmFtZSk7XG4gICAgfVxuXG4gICAgaWYgKGJvdW5kTG9nR3JvdXApIHtcbiAgICAgICh0aGlzIGFzIHsgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cFJlZiB9KS5sb2dHcm91cCA9IGJvdW5kTG9nR3JvdXA7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEFub255bW91cyBMYW1iZGEgcGh5c2ljYWwgbmFtZXMgYXJlIGdlbmVyYXRlZCBieSBDbG91ZEZvcm1hdGlvbi4gS2VlcFxuICAgICAgLy8gdGhlIGZpbml0ZS1yZXRlbnRpb24gbG9nIGdyb3VwLCBidXQgcmVxdWlyZSBjYWxsZXJzIHRoYXQgbmVlZCBhXG4gICAgICAvLyBmYWlsLXNhZmUgZXhpc3Rpbmctc3RhY2sgdXBncmFkZS9hZG9wdGlvbiBwYXRoIHRvIHBhc3MgbG9nR3JvdXAgb3IgYVxuICAgICAgLy8gY29uY3JldGUgZnVuY3Rpb25OYW1lIHNvIHRoZSBMYW1iZGEgTDIgY2FuIGJpbmQgdGhlIGdyb3VwIHVwIGZyb250LlxuICAgICAgY29uc3QgbG9nR3JvdXAgPSBjcmVhdGVNYW5hZ2VkRnVuY3Rpb25Mb2dHcm91cChcbiAgICAgICAgdGhpcyxcbiAgICAgICAgYC9hd3MvbGFtYmRhLyR7dGhpcy5mbi5mdW5jdGlvbk5hbWV9YCxcbiAgICAgICAgbG9nUmV0ZW50aW9uLFxuICAgICAgICByZXF1ZXN0ZWRMb2dSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgKTtcbiAgICAgICh0aGlzIGFzIHsgbG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cFJlZiB9KS5sb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgIH1cblxuICAgIGlmIChhbGlhcykge1xuICAgICAgdGhpcy5jb25maWd1cmVBbGlhcyhhbGlhcyk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVBbGlhcyhvcHRpb25zOiBBcHBUaGVvcnlGdW5jdGlvbkFsaWFzT3B0aW9ucyk6IHZvaWQge1xuICAgIGNvbnN0IGFsaWFzTmFtZSA9IFN0cmluZyhvcHRpb25zLm5hbWUgPz8gXCJsaXZlXCIpLnRyaW0oKTtcbiAgICBpZiAoIWFsaWFzTmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gYWxpYXMubmFtZSBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBhbGlhcyA9IG5ldyBsYW1iZGEuQWxpYXModGhpcywgXCJBbGlhc1wiLCB7XG4gICAgICBhbGlhc05hbWUsXG4gICAgICB2ZXJzaW9uOiB0aGlzLmZuLmN1cnJlbnRWZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IG9wdGlvbnMuZGVzY3JpcHRpb24sXG4gICAgICBwcm92aXNpb25lZENvbmN1cnJlbnRFeGVjdXRpb25zOiBvcHRpb25zLnByb3Zpc2lvbmVkQ29uY3VycmVudEV4ZWN1dGlvbnMsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBhbGlhcz86IGxhbWJkYS5BbGlhcyB9KS5hbGlhcyA9IGFsaWFzO1xuXG4gICAgaWYgKG9wdGlvbnMuZGVwbG95bWVudCkge1xuICAgICAgY29uc3QgZGVwbG95bWVudEdyb3VwID0gbmV3IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwKHRoaXMsIFwiRGVwbG95bWVudEdyb3VwXCIsIHtcbiAgICAgICAgYWxpYXMsXG4gICAgICAgIGRlcGxveW1lbnRDb25maWc6IGRlcGxveW1lbnRDb25maWdGb3IodGhpcywgb3B0aW9ucy5kZXBsb3ltZW50KSxcbiAgICAgICAgYWxhcm1zOiBvcHRpb25zLmRlcGxveW1lbnQuYWxhcm1zLFxuICAgICAgICBwcmVIb29rOiBvcHRpb25zLmRlcGxveW1lbnQucHJlSG9vayxcbiAgICAgICAgcG9zdEhvb2s6IG9wdGlvbnMuZGVwbG95bWVudC5wb3N0SG9vayxcbiAgICAgICAgYXV0b1JvbGxiYWNrOiBvcHRpb25zLmRlcGxveW1lbnQuYXV0b1JvbGxiYWNrLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGRlcGxveW1lbnRHcm91cD86IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwIH0pLmRlcGxveW1lbnRHcm91cCA9IGRlcGxveW1lbnRHcm91cDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlTWFuYWdlZEZ1bmN0aW9uTG9nR3JvdXAoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGxvZ0dyb3VwTmFtZTogc3RyaW5nLFxuICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cyxcbiAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeSxcbik6IGxvZ3MuTG9nR3JvdXAge1xuICBpZiAocmVtb3ZhbFBvbGljeSA9PT0gUmVtb3ZhbFBvbGljeS5TTkFQU0hPVCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5RnVuY3Rpb24gY2Fubm90IGFwcGx5IFJlbW92YWxQb2xpY3kuU05BUFNIT1QgYmVjYXVzZSBBV1M6OkxvZ3M6OkxvZ0dyb3VwIGRvZXMgbm90IHN1cHBvcnQgc25hcHNob3QgcmVtb3ZhbCBwb2xpY2llc1wiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHNjb3BlLCBcIkxvZ0dyb3VwXCIsIHtcbiAgICBsb2dHcm91cE5hbWUsXG4gICAgcmV0ZW50aW9uLFxuICB9KTtcblxuICBjb25zdCBsb2dHcm91cFJlc291cmNlID0gbG9nR3JvdXAubm9kZS5kZWZhdWx0Q2hpbGQ7XG4gIGlmICghKGxvZ0dyb3VwUmVzb3VyY2UgaW5zdGFuY2VvZiBsb2dzLkNmbkxvZ0dyb3VwKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgYXBwbHkgbG9nUmVtb3ZhbFBvbGljeSAke0pTT04uc3RyaW5naWZ5KHJlbW92YWxQb2xpY3kpfSBiZWNhdXNlIHRoZSBBcHBUaGVvcnktbWFuYWdlZCBsb2cgZ3JvdXAncyBkZWZhdWx0IGNoaWxkIGlzIG5vdCBhbiBBV1M6OkxvZ3M6OkxvZ0dyb3VwYCxcbiAgICApO1xuICB9XG4gIGxvZ0dyb3VwUmVzb3VyY2UuYXBwbHlSZW1vdmFsUG9saWN5KHJlbW92YWxQb2xpY3kpO1xuXG4gIHJldHVybiBsb2dHcm91cDtcbn1cblxuZnVuY3Rpb24gZGVwbG95bWVudENvbmZpZ0ZvcihzY29wZTogQ29uc3RydWN0LCBvcHRpb25zOiBBcHBUaGVvcnlGdW5jdGlvbkRlcGxveW1lbnRPcHRpb25zKTogY29kZWRlcGxveS5JTGFtYmRhRGVwbG95bWVudENvbmZpZyB7XG4gIGNvbnN0IHR5cGUgPSBvcHRpb25zLnRyYWZmaWNTaGlmdFR5cGUgPz8gQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5DQU5BUlk7XG4gIHN3aXRjaCAodHlwZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5BTExfQVRfT05DRTpcbiAgICAgIHJldHVybiBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRDb25maWcuQUxMX0FUX09OQ0U7XG4gICAgY2FzZSBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkxJTkVBUjpcbiAgICAgIHJldHVybiBuZXcgY29kZWRlcGxveS5MYW1iZGFEZXBsb3ltZW50Q29uZmlnKHNjb3BlLCBcIkxpbmVhckRlcGxveW1lbnRDb25maWdcIiwge1xuICAgICAgICB0cmFmZmljUm91dGluZzogY29kZWRlcGxveS5UcmFmZmljUm91dGluZy50aW1lQmFzZWRMaW5lYXIoe1xuICAgICAgICAgIHBlcmNlbnRhZ2U6IG5vcm1hbGl6ZWRQZXJjZW50YWdlKG9wdGlvbnMucGVyY2VudGFnZSksXG4gICAgICAgICAgaW50ZXJ2YWw6IG9wdGlvbnMuaW50ZXJ2YWwgPz8gRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgICAgfSksXG4gICAgICB9KTtcbiAgICBjYXNlIEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGUuQ0FOQVJZOlxuICAgICAgcmV0dXJuIG5ldyBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRDb25maWcoc2NvcGUsIFwiQ2FuYXJ5RGVwbG95bWVudENvbmZpZ1wiLCB7XG4gICAgICAgIHRyYWZmaWNSb3V0aW5nOiBjb2RlZGVwbG95LlRyYWZmaWNSb3V0aW5nLnRpbWVCYXNlZENhbmFyeSh7XG4gICAgICAgICAgcGVyY2VudGFnZTogbm9ybWFsaXplZFBlcmNlbnRhZ2Uob3B0aW9ucy5wZXJjZW50YWdlKSxcbiAgICAgICAgICBpbnRlcnZhbDogb3B0aW9ucy5pbnRlcnZhbCA/PyBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeUZ1bmN0aW9uIHVuc3VwcG9ydGVkIGRlcGxveW1lbnQgdHlwZTogJHtTdHJpbmcodHlwZSl9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplZFBlcmNlbnRhZ2UoaW5wdXQ/OiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCB2YWx1ZSA9IGlucHV0ID8/IDEwO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCB8fCB2YWx1ZSA+PSAxMDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlGdW5jdGlvbiBkZXBsb3ltZW50IHBlcmNlbnRhZ2UgbXVzdCBiZSBncmVhdGVyIHRoYW4gMCBhbmQgbGVzcyB0aGFuIDEwMFwiKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG4iXX0=