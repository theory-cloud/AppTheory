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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryFunction", version: "6.3.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZnVuY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJmdW5jdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTZEO0FBRTdELHVFQUF5RDtBQUN6RCx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkM7O0dBRUc7QUFDSCxJQUFZLCtCQWVYO0FBZkQsV0FBWSwrQkFBK0I7SUFDekM7O09BRUc7SUFDSCw4REFBMkIsQ0FBQTtJQUUzQjs7T0FFRztJQUNILG9EQUFpQixDQUFBO0lBRWpCOztPQUVHO0lBQ0gsb0RBQWlCLENBQUE7QUFDbkIsQ0FBQyxFQWZXLCtCQUErQiwrQ0FBL0IsK0JBQStCLFFBZTFDO0FBMEhELE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzlCLEVBQUUsQ0FBa0I7SUFDcEIsUUFBUSxDQUFxQjtJQUM3QixLQUFLLENBQWdCO0lBQ3JCLGVBQWUsQ0FBb0M7SUFFbkUsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE2QjtRQUNyRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLEdBQUcsZ0JBQWdCLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDdkQsTUFBTSxXQUFXLEdBQXlCLEVBQUUsR0FBRyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ2xFLElBQUksUUFBUSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQzNCLElBQUksV0FBVyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNyQixNQUFNLElBQUksS0FBSyxDQUNiLDZKQUE2SixDQUM5SixDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7UUFDRCxNQUFNLFlBQVksR0FBRyxXQUFXLENBQUMsWUFBWSxJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDO1FBQzlFLE1BQU0s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b3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoXCI7XG5pbXBvcnQgKiBhcyBjb2RlZGVwbG95IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY29kZWRlcGxveVwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIFRyYWZmaWMgc2hpZnRpbmcgbW9kZSBmb3IgQXBwVGhlb3J5LW1hbmFnZWQgTGFtYmRhIGFsaWFzZXMuXG4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGUge1xuICAvKipcbiAgICogU2hpZnQgYWxsIHRyYWZmaWMgdG8gdGhlIG5ldyB2ZXJzaW9uIGF0IG9uY2UuXG4gICAqL1xuICBBTExfQVRfT05DRSA9IFwiQUxMX0FUX09OQ0VcIixcblxuICAvKipcbiAgICogU2hpZnQgb25lIGNhbmFyeSBpbmNyZW1lbnQsIHdhaXQsIHRoZW4gc2hpZnQgdGhlIHJlbWFpbmluZyB0cmFmZmljLlxuICAgKi9cbiAgQ0FOQVJZID0gXCJDQU5BUllcIixcblxuICAvKipcbiAgICogU2hpZnQgdHJhZmZpYyBpbiBlcXVhbCBsaW5lYXIgaW5jcmVtZW50cy5cbiAgICovXG4gIExJTkVBUiA9IFwiTElORUFSXCIsXG59XG5cbi8qKlxuICogQ29kZURlcGxveSBkZXBsb3ltZW50IHByZWZlcmVuY2VzIGZvciBhbiBBcHBUaGVvcnkgTGFtYmRhIGFsaWFzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUZ1bmN0aW9uRGVwbG95bWVudE9wdGlvbnMge1xuICAvKipcbiAgICogVHJhZmZpYyBzaGlmdGluZyBtb2RlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkNBTkFSWVxuICAgKi9cbiAgcmVhZG9ubHkgdHJhZmZpY1NoaWZ0VHlwZT86IEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGU7XG5cbiAgLyoqXG4gICAqIFBlcmNlbnRhZ2Ugc2hpZnRlZCBhdCBlYWNoIGNhbmFyeSBvciBsaW5lYXIgaW5jcmVtZW50LlxuICAgKiBAZGVmYXVsdCAxMFxuICAgKi9cbiAgcmVhZG9ubHkgcGVyY2VudGFnZT86IG51bWJlcjtcblxuICAvKipcbiAgICogVGltZSBiZXR3ZWVuIHRyYWZmaWMgc2hpZnRzLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDUpIGZvciBjYW5hcnksIER1cmF0aW9uLm1pbnV0ZXMoMSkgZm9yIGxpbmVhclxuICAgKi9cbiAgcmVhZG9ubHkgaW50ZXJ2YWw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogQ2xvdWRXYXRjaCBhbGFybXMgdGhhdCBzdG9wIGFuZCByb2xsIGJhY2sgZGVwbG95bWVudHMuXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBhbGFybXM/OiBjbG91ZHdhdGNoLklBbGFybVtdO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcHJlLXRyYWZmaWMgaG9vay5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBwcmVIb29rPzogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogTGFtYmRhIHBvc3QtdHJhZmZpYyBob29rLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHBvc3RIb29rPzogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogQ29kZURlcGxveSBhdXRvLXJvbGxiYWNrIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IENvZGVEZXBsb3kgZGVmYXVsdHNcbiAgICovXG4gIHJlYWRvbmx5IGF1dG9Sb2xsYmFjaz86IGNvZGVkZXBsb3kuQXV0b1JvbGxiYWNrQ29uZmlnO1xufVxuXG4vKipcbiAqIEFsaWFzIGFuZCBwcm92aXNpb25lZC1jb25jdXJyZW5jeSBvcHRpb25zIGZvciBhbiBBcHBUaGVvcnkgZnVuY3Rpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5RnVuY3Rpb25BbGlhc09wdGlvbnMge1xuICAvKipcbiAgICogTGFtYmRhIGFsaWFzIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwibGl2ZVwiXG4gICAqL1xuICByZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBbGlhcyBkZXNjcmlwdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgY29uY3VycmVuY3kgY29uZmlndXJlZCBvbiB0aGUgYWxpYXMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcHJvdmlzaW9uZWRDb25jdXJyZW50RXhlY3V0aW9ucz86IG51bWJlcjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ29kZURlcGxveSB0cmFmZmljIHNoaWZ0aW5nIGZvciB0aGlzIGFsaWFzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRlcGxveW1lbnQ/OiBBcHBUaGVvcnlGdW5jdGlvbkRlcGxveW1lbnRPcHRpb25zO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGFuIEFwcFRoZW9yeS1tYW5hZ2VkIExhbWJkYSBmdW5jdGlvbi5cbiAqXG4gKiBBcHBUaGVvcnkgb3ZlcnJpZGVzIHRoZSBpbmhlcml0ZWQgYGxvZ1JlbW92YWxQb2xpY3lgIGRlZmF1bHQgZm9yIGxvZyBncm91cHNcbiAqIGl0IGNyZWF0ZXM6IHRoZXkgdXNlIGBSZW1vdmFsUG9saWN5LlJFVEFJTmAsIHNvIGRlbGV0aW5nIGEgc3RhY2sgcHJlc2VydmVzXG4gKiB0aGUgZXhlY3V0aW9uIGxvZ3MuIFBhc3MgYFJlbW92YWxQb2xpY3kuREVTVFJPWWAgZXhwbGljaXRseSB0byBvcHQgYmFjayBpbnRvXG4gKiB0aGUgZGVzdHJ1Y3RpdmUgYmVoYXZpb3IuIENvbWJpbmluZyBhbiBleHBsaWNpdCBgbG9nUmVtb3ZhbFBvbGljeWAgd2l0aCBhXG4gKiBjYWxsZXItcHJvdmlkZWQgYGxvZ0dyb3VwYCBmYWlscyBzeW50aGVzaXMgYmVjYXVzZSBjYWxsZXItcHJvdmlkZWQgcmVzb3VyY2VzXG4gKiBvd24gdGhlaXIgcmVtb3ZhbCBwb2xpY3kuXG4gKlxuICogQm90aCBgbG9nUmV0ZW50aW9uYCBhbmQgYGxvZ1JlbW92YWxQb2xpY3lgIGFyZSBkZXByZWNhdGVkIHVwc3RyZWFtIGluIGZhdm9yXG4gKiBvZiBgbG9nR3JvdXBgIChgQGRlcHJlY2F0ZWQgdXNlIGxvZ0dyb3VwIGluc3RlYWRgIG9uIHRoZSBpbmhlcml0ZWQgTGFtYmRhIEwyXG4gKiBwcm9wcykuIFRoZSBtaWdyYXRpb24gaXMgdG8gY3JlYXRlIGEgYGxvZ3MuTG9nR3JvdXBgIHdpdGggdGhlIGRlc2lyZWRcbiAqIGByZXRlbnRpb25gIGFuZCBgcmVtb3ZhbFBvbGljeWAgYW5kIHBhc3MgaXQgYXMgYGxvZ0dyb3VwYDsgQXBwVGhlb3J5IHRoZW5cbiAqIHVzZXMgdGhhdCBncm91cCB1bmNoYW5nZWQuIEFuIGV4cGxpY2l0IGBsb2dHcm91cGAgd2lucyBvdmVyIGBsb2dSZXRlbnRpb25gLFxuICogYW5kIGNvbWJpbmluZyBpdCB3aXRoIGBsb2dSZW1vdmFsUG9saWN5YCBmYWlscyBzeW50aGVzaXMuXG4gKlxuICoganNpaSBmb3JiaWRzIHJlLWRlY2xhcmluZyB0aGUgaW5oZXJpdGVkIHByb3BzLCBzbyB0aGUgZGVwcmVjYXRpb24gbm90aWNlIGlzXG4gKiBjYXJyaWVkIGJ5IHRoZSBiYXNlIExhbWJkYSBMMiBpbnRlcmZhY2UgcmF0aGVyIHRoYW4gcmVzdGF0ZWQgaGVyZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge1xuICAvKipcbiAgICogU3RhYmxlIHBoeXNpY2FsIG5hbWUgZm9yIHRoZSBBcHBUaGVvcnktbWFuYWdlZCBMYW1iZGEgZXhlY3V0aW9uIHJvbGUuXG4gICAqXG4gICAqIEFwcFRoZW9yeSBwcmVzZXJ2ZXMgdGhlIExhbWJkYSBMMidzIHBvbGljaWVzLiBDb25jcmV0ZSBuYW1lcyBhcmUgc3ludGhlc2lzLXZhbGlkYXRlZCBhZ2FpbnN0IElBTSdzIGBbXFx3Kz0sLkAtXStgIGNoYXJhY3RlciBzZXQgYW5kIDY0LWNoYXJhY3RlciBsaW1pdC5cbiAgICogVG9rZW4tdmFsdWVkIG5hbWVzIGFyZSBhY2NlcHRlZCBhbmQgSUFNIHZhbGlkYXRlcyB0aGUgcmVzb2x2ZWQgdmFsdWUgYXQgZGVwbG95IHRpbWUsIHNvIGFuIGludmFsaWQgcmVzb2x2ZWQgbmFtZSBmYWlscyBkZXBsb3ltZW50IHJhdGhlciB0aGFuIHN5bnRoZXNpcy5cbiAgICogVGhpcyBleGVtcHRpb24ga2VlcHMgYWNjb3VudC1hZ25vc3RpYyBzeW50aGVzaXMgcmVwcmVzZW50YWJsZSBmb3IgdGhlIFRIRS0yODYxIHRva2VuLXZhbHVlZC1pbnB1dCBmYWlsdXJlIGNsYXNzLiBEbyBub3QgY29tYmluZSB0aGlzIHdpdGggdGhlIGluaGVyaXRlZCBgcm9sZWBcbiAgICogcHJvcDsgY2FsbGVyLXByb3ZpZGVkIHJvbGVzIG93biB0aGVpciBwaHlzaWNhbCBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJvbGVOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBcHBUaGVvcnktbWFuYWdlZCBMYW1iZGEgYWxpYXMuXG4gICAqXG4gICAqIFdoZW4gc2V0LCB0aGUgYWxpYXMgcG9pbnRzIGF0IHRoZSBmdW5jdGlvbidzIGN1cnJlbnQgdmVyc2lvbiBhbmQgY2FuIGFsc29cbiAgICogY2FycnkgcHJvdmlzaW9uZWQgY29uY3VycmVuY3kgYW5kIENvZGVEZXBsb3kgdHJhZmZpYyBzaGlmdGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhbGlhcz86IEFwcFRoZW9yeUZ1bmN0aW9uQWxpYXNPcHRpb25zO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5RnVuY3Rpb24gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgZm46IGxhbWJkYS5GdW5jdGlvbjtcbiAgcHVibGljIHJlYWRvbmx5IGxvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXBSZWY7XG4gIHB1YmxpYyByZWFkb25seSBhbGlhcz86IGxhbWJkYS5BbGlhcztcbiAgcHVibGljIHJlYWRvbmx5IGRlcGxveW1lbnRHcm91cD86IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudEdyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlGdW5jdGlvblByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgYWxpYXMsIHJvbGVOYW1lLCAuLi5pbnB1dExhbWJkYVByb3BzIH0gPSBwcm9wcztcbiAgICBjb25zdCBsYW1iZGFQcm9wczogbGFtYmRhLkZ1bmN0aW9uUHJvcHMgPSB7IC4uLmlucHV0TGFtYmRhUHJvcHMgfTtcbiAgICBpZiAocm9sZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGxhbWJkYVByb3BzLnJvbGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiQXBwVGhlb3J5RnVuY3Rpb24gY2Fubm90IGhvbm9yIHByb3BzLnJvbGVOYW1lIHdoZW4gcHJvcHMucm9sZSBzdXBwbGllcyB0aGUgZXhlY3V0aW9uIHJvbGU7IG9taXQgcHJvcHMucm9sZSBvciBjb25maWd1cmUgaXRzIG5hbWUgd2hlcmUgdGhhdCByb2xlIGlzIGNyZWF0ZWRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgbG9nUmV0ZW50aW9uID0gbGFtYmRhUHJvcHMubG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEg7XG4gICAgY29uc3QgcmVxdWVzdGVkTG9nUmVtb3ZhbFBvbGljeSA9IGxhbWJkYVByb3BzLmxvZ1JlbW92YWxQb2xpY3k7XG4gICAgaWYgKGxhbWJkYVByb3BzLmxvZ0dyb3VwICYmIHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBob25vciBwcm9wcy5sb2dSZW1vdmFsUG9saWN5IHdoZW4gcHJvcHMubG9nR3JvdXAgc3VwcGxpZXMgdGhlIGxvZyBncm91cDsgb21pdCBwcm9wcy5sb2dSZW1vdmFsUG9saWN5IG9yIGNvbmZpZ3VyZSB0aGUgcmVtb3ZhbCBwb2xpY3kgd2hlcmUgdGhhdCBsb2cgZ3JvdXAgaXMgY3JlYXRlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cyB9KS5sb2dSZXRlbnRpb247XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JlbW92YWxQb2xpY3k/OiB1bmtub3duIH0pLmxvZ1JlbW92YWxQb2xpY3k7XG4gICAgZGVsZXRlIChsYW1iZGFQcm9wcyBhcyB7IGxvZ1JldGVudGlvblJldHJ5T3B0aW9ucz86IHVua25vd24gfSkubG9nUmV0ZW50aW9uUmV0cnlPcHRpb25zO1xuICAgIGRlbGV0ZSAobGFtYmRhUHJvcHMgYXMgeyBsb2dSZXRlbnRpb25Sb2xlPzogdW5rbm93biB9KS5sb2dSZXRlbnRpb25Sb2xlO1xuXG4gICAgbGV0IGJvdW5kTG9nR3JvdXAgPSBsYW1iZGFQcm9wcy5sb2dHcm91cDtcbiAgICBpZiAoIWJvdW5kTG9nR3JvdXAgJiYgbGFtYmRhUHJvcHMuZnVuY3Rpb25OYW1lKSB7XG4gICAgICBib3VuZExvZ0dyb3VwID0gY3JlYXRlTWFuYWdlZEZ1bmN0aW9uTG9nR3JvdXAoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGAvYXdzL2xhbWJkYS8ke2xhbWJkYVByb3BzLmZ1bmN0aW9uTmFtZX1gLFxuICAgICAgICBsb2dSZXRlbnRpb24sXG4gICAgICAgIHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICApO1xuICAgIH1cblxuICAgIHRoaXMuZm4gPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiRnVuY3Rpb25cIiwge1xuICAgICAgLi4ubGFtYmRhUHJvcHMsXG4gICAgICBsb2dHcm91cDogYm91bmRMb2dHcm91cCxcbiAgICAgIGFyY2hpdGVjdHVyZTogbGFtYmRhUHJvcHMuYXJjaGl0ZWN0dXJlID8/IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgdHJhY2luZzogbGFtYmRhUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBsYW1iZGFQcm9wcy5tZW1vcnlTaXplID8/IDI1NixcbiAgICAgIHRpbWVvdXQ6IGxhbWJkYVByb3BzLnRpbWVvdXQgPz8gRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgfSk7XG5cbiAgICBpZiAocm9sZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocm9sZU5hbWUpKSB7XG4gICAgICAgIGlmICghcm9sZU5hbWUudHJpbSgpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBub3QgYmUgZW1wdHlcIik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJvbGVOYW1lLmxlbmd0aCA+IDY0KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBub3QgZXhjZWVkIDY0IGNoYXJhY3RlcnNcIik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCEvXltcXHcrPSwuQC1dKyQvLnRlc3Qocm9sZU5hbWUpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5RnVuY3Rpb24gcm9sZU5hbWUgbXVzdCBtYXRjaCBbXFxcXHcrPSwuQC1dK1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3Qgcm9sZVJlc291cmNlID0gdGhpcy5mbi5yb2xlPy5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgICAgIGlmICghKHJvbGVSZXNvdXJjZSBpbnN0YW5jZW9mIGlhbS5DZm5Sb2xlKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBhcHBseSB0aGUgcmVxdWlyZWQgc3RhYmxlIHJvbGVOYW1lICR7SlNPTi5zdHJpbmdpZnkocm9sZU5hbWUpfSBiZWNhdXNlIHRoZSBMYW1iZGEgZXhlY3V0aW9uIHJvbGUncyBkZWZhdWx0IGNoaWxkIGlzIG5vdCBhbiBBV1M6OklBTTo6Um9sZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByb2xlUmVzb3VyY2UuYWRkUHJvcGVydHlPdmVycmlkZShcIlJvbGVOYW1lXCIsIHJvbGVOYW1lKTtcbiAgICB9XG5cbiAgICBpZiAoYm91bmRMb2dHcm91cCkge1xuICAgICAgKHRoaXMgYXMgeyBsb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwUmVmIH0pLmxvZ0dyb3VwID0gYm91bmRMb2dHcm91cDtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQW5vbnltb3VzIExhbWJkYSBwaHlzaWNhbCBuYW1lcyBhcmUgZ2VuZXJhdGVkIGJ5IENsb3VkRm9ybWF0aW9uLiBLZWVwXG4gICAgICAvLyB0aGUgZmluaXRlLXJldGVudGlvbiBsb2cgZ3JvdXAsIGJ1dCByZXF1aXJlIGNhbGxlcnMgdGhhdCBuZWVkIGFcbiAgICAgIC8vIGZhaWwtc2FmZSBleGlzdGluZy1zdGFjayB1cGdyYWRlL2Fkb3B0aW9uIHBhdGggdG8gcGFzcyBsb2dHcm91cCBvciBhXG4gICAgICAvLyBjb25jcmV0ZSBmdW5jdGlvbk5hbWUgc28gdGhlIExhbWJkYSBMMiBjYW4gYmluZCB0aGUgZ3JvdXAgdXAgZnJvbnQuXG4gICAgICBjb25zdCBsb2dHcm91cCA9IGNyZWF0ZU1hbmFnZWRGdW5jdGlvbkxvZ0dyb3VwKFxuICAgICAgICB0aGlzLFxuICAgICAgICBgL2F3cy9sYW1iZGEvJHt0aGlzLmZuLmZ1bmN0aW9uTmFtZX1gLFxuICAgICAgICBsb2dSZXRlbnRpb24sXG4gICAgICAgIHJlcXVlc3RlZExvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICApO1xuICAgICAgKHRoaXMgYXMgeyBsb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwUmVmIH0pLmxvZ0dyb3VwID0gbG9nR3JvdXA7XG4gICAgfVxuXG4gICAgaWYgKGFsaWFzKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZUFsaWFzKGFsaWFzKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFsaWFzKG9wdGlvbnM6IEFwcFRoZW9yeUZ1bmN0aW9uQWxpYXNPcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgYWxpYXNOYW1lID0gU3RyaW5nKG9wdGlvbnMubmFtZSA/PyBcImxpdmVcIikudHJpbSgpO1xuICAgIGlmICghYWxpYXNOYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlGdW5jdGlvbiBhbGlhcy5uYW1lIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGFsaWFzID0gbmV3IGxhbWJkYS5BbGlhcyh0aGlzLCBcIkFsaWFzXCIsIHtcbiAgICAgIGFsaWFzTmFtZSxcbiAgICAgIHZlcnNpb246IHRoaXMuZm4uY3VycmVudFZlcnNpb24sXG4gICAgICBkZXNjcmlwdGlvbjogb3B0aW9ucy5kZXNjcmlwdGlvbixcbiAgICAgIHByb3Zpc2lvbmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IG9wdGlvbnMucHJvdmlzaW9uZWRDb25jdXJyZW50RXhlY3V0aW9ucyxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFsaWFzPzogbGFtYmRhLkFsaWFzIH0pLmFsaWFzID0gYWxpYXM7XG5cbiAgICBpZiAob3B0aW9ucy5kZXBsb3ltZW50KSB7XG4gICAgICBjb25zdCBkZXBsb3ltZW50R3JvdXAgPSBuZXcgY29kZWRlcGxveS5MYW1iZGFEZXBsb3ltZW50R3JvdXAodGhpcywgXCJEZXBsb3ltZW50R3JvdXBcIiwge1xuICAgICAgICBhbGlhcyxcbiAgICAgICAgZGVwbG95bWVudENvbmZpZzogZGVwbG95bWVudENvbmZpZ0Zvcih0aGlzLCBvcHRpb25zLmRlcGxveW1lbnQpLFxuICAgICAgICBhbGFybXM6IG9wdGlvbnMuZGVwbG95bWVudC5hbGFybXMsXG4gICAgICAgIHByZUhvb2s6IG9wdGlvbnMuZGVwbG95bWVudC5wcmVIb29rLFxuICAgICAgICBwb3N0SG9vazogb3B0aW9ucy5kZXBsb3ltZW50LnBvc3RIb29rLFxuICAgICAgICBhdXRvUm9sbGJhY2s6IG9wdGlvbnMuZGVwbG95bWVudC5hdXRvUm9sbGJhY2ssXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgZGVwbG95bWVudEdyb3VwPzogY29kZWRlcGxveS5MYW1iZGFEZXBsb3ltZW50R3JvdXAgfSkuZGVwbG95bWVudEdyb3VwID0gZGVwbG95bWVudEdyb3VwO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVNYW5hZ2VkRnVuY3Rpb25Mb2dHcm91cChcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgbG9nR3JvdXBOYW1lOiBzdHJpbmcsXG4gIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLFxuICByZW1vdmFsUG9saWN5OiBSZW1vdmFsUG9saWN5LFxuKTogbG9ncy5Mb2dHcm91cCB7XG4gIGlmIChyZW1vdmFsUG9saWN5ID09PSBSZW1vdmFsUG9saWN5LlNOQVBTSE9UKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlGdW5jdGlvbiBjYW5ub3QgYXBwbHkgUmVtb3ZhbFBvbGljeS5TTkFQU0hPVCBiZWNhdXNlIEFXUzo6TG9nczo6TG9nR3JvdXAgZG9lcyBub3Qgc3VwcG9ydCBzbmFwc2hvdCByZW1vdmFsIHBvbGljaWVzXCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAoc2NvcGUsIFwiTG9nR3JvdXBcIiwge1xuICAgIGxvZ0dyb3VwTmFtZSxcbiAgICByZXRlbnRpb24sXG4gIH0pO1xuXG4gIGNvbnN0IGxvZ0dyb3VwUmVzb3VyY2UgPSBsb2dHcm91cC5ub2RlLmRlZmF1bHRDaGlsZDtcbiAgaWYgKCEobG9nR3JvdXBSZXNvdXJjZSBpbnN0YW5jZW9mIGxvZ3MuQ2ZuTG9nR3JvdXApKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUZ1bmN0aW9uIGNhbm5vdCBhcHBseSBsb2dSZW1vdmFsUG9saWN5ICR7SlNPTi5zdHJpbmdpZnkocmVtb3ZhbFBvbGljeSl9IGJlY2F1c2UgdGhlIEFwcFRoZW9yeS1tYW5hZ2VkIGxvZyBncm91cCdzIGRlZmF1bHQgY2hpbGQgaXMgbm90IGFuIEFXUzo6TG9nczo6TG9nR3JvdXBgLFxuICAgICk7XG4gIH1cbiAgbG9nR3JvdXBSZXNvdXJjZS5hcHBseVJlbW92YWxQb2xpY3kocmVtb3ZhbFBvbGljeSk7XG5cbiAgcmV0dXJuIGxvZ0dyb3VwO1xufVxuXG5mdW5jdGlvbiBkZXBsb3ltZW50Q29uZmlnRm9yKHNjb3BlOiBDb25zdHJ1Y3QsIG9wdGlvbnM6IEFwcFRoZW9yeUZ1bmN0aW9uRGVwbG95bWVudE9wdGlvbnMpOiBjb2RlZGVwbG95LklMYW1iZGFEZXBsb3ltZW50Q29uZmlnIHtcbiAgY29uc3QgdHlwZSA9IG9wdGlvbnMudHJhZmZpY1NoaWZ0VHlwZSA/PyBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkNBTkFSWTtcbiAgc3dpdGNoICh0eXBlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlMYW1iZGFUcmFmZmljU2hpZnRUeXBlLkFMTF9BVF9PTkNFOlxuICAgICAgcmV0dXJuIGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudENvbmZpZy5BTExfQVRfT05DRTtcbiAgICBjYXNlIEFwcFRoZW9yeUxhbWJkYVRyYWZmaWNTaGlmdFR5cGUuTElORUFSOlxuICAgICAgcmV0dXJuIG5ldyBjb2RlZGVwbG95LkxhbWJkYURlcGxveW1lbnRDb25maWcoc2NvcGUsIFwiTGluZWFyRGVwbG95bWVudENvbmZpZ1wiLCB7XG4gICAgICAgIHRyYWZmaWNSb3V0aW5nOiBjb2RlZGVwbG95LlRyYWZmaWNSb3V0aW5nLnRpbWVCYXNlZExpbmVhcih7XG4gICAgICAgICAgcGVyY2VudGFnZTogbm9ybWFsaXplZFBlcmNlbnRhZ2Uob3B0aW9ucy5wZXJjZW50YWdlKSxcbiAgICAgICAgICBpbnRlcnZhbDogb3B0aW9ucy5pbnRlcnZhbCA/PyBEdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgIGNhc2UgQXBwVGhlb3J5TGFtYmRhVHJhZmZpY1NoaWZ0VHlwZS5DQU5BUlk6XG4gICAgICByZXR1cm4gbmV3IGNvZGVkZXBsb3kuTGFtYmRhRGVwbG95bWVudENvbmZpZyhzY29wZSwgXCJDYW5hcnlEZXBsb3ltZW50Q29uZmlnXCIsIHtcbiAgICAgICAgdHJhZmZpY1JvdXRpbmc6IGNvZGVkZXBsb3kuVHJhZmZpY1JvdXRpbmcudGltZUJhc2VkQ2FuYXJ5KHtcbiAgICAgICAgICBwZXJjZW50YWdlOiBub3JtYWxpemVkUGVyY2VudGFnZShvcHRpb25zLnBlcmNlbnRhZ2UpLFxuICAgICAgICAgIGludGVydmFsOiBvcHRpb25zLmludGVydmFsID8/IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5RnVuY3Rpb24gdW5zdXBwb3J0ZWQgZGVwbG95bWVudCB0eXBlOiAke1N0cmluZyh0eXBlKX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVkUGVyY2VudGFnZShpbnB1dD86IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IHZhbHVlID0gaW5wdXQgPz8gMTA7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwIHx8IHZhbHVlID49IDEwMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUZ1bmN0aW9uIGRlcGxveW1lbnQgcGVyY2VudGFnZSBtdXN0IGJlIGdyZWF0ZXIgdGhhbiAwIGFuZCBsZXNzIHRoYW4gMTAwXCIpO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cbiJdfQ==