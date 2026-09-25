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
exports.AppTheoryCloudWatchLogsDestination = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
/**
 * CloudWatch Logs destination that delivers subscription records to Kinesis.
 *
 * The construct owns the destination, the CloudWatch Logs service role, and a fail-closed
 * destination policy. Subscription filter writers must be explicitly allowed by source account
 * and/or AWS Organization ID; no unconstrained wildcard principal is synthesized.
 */
class AppTheoryCloudWatchLogsDestination extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryCloudWatchLogsDestination", version: "4.4.1" };
    /**
     * The CloudWatch Logs destination resource.
     */
    destination;
    /**
     * IAM role assumed by CloudWatch Logs to write records to the target stream.
     */
    serviceRole;
    /**
     * The destination ARN.
     */
    destinationArn;
    /**
     * The destination name.
     */
    destinationName;
    constructor(scope, id, props) {
        super(scope, id);
        const allowedSourceAccounts = normalizeUniqueList(props.allowedSourceAccounts ?? [], "allowedSourceAccounts", validateAccountId);
        const allowedOrganizationIds = normalizeUniqueList(props.allowedOrganizationIds ?? [], "allowedOrganizationIds", validateOrganizationId);
        if (allowedSourceAccounts.length === 0 && allowedOrganizationIds.length === 0) {
            throw new Error("AppTheoryCloudWatchLogsDestination requires allowedSourceAccounts and/or allowedOrganizationIds");
        }
        this.destinationName = destinationName(this, props.destinationName);
        this.destinationArn = aws_cdk_lib_1.Stack.of(this).formatArn({
            service: "logs",
            resource: "destination",
            resourceName: this.destinationName,
            arnFormat: aws_cdk_lib_1.ArnFormat.COLON_RESOURCE_NAME,
        });
        this.serviceRole = new iam.Role(this, "ServiceRole", {
            assumedBy: servicePrincipalWithConditions(sourceArnTrustConditions(this, allowedSourceAccounts)),
        });
        if (allowedOrganizationIds.length > 0) {
            this.serviceRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
                actions: ["sts:AssumeRole"],
                principals: [servicePrincipalWithConditions(sourceOrgTrustConditions(allowedOrganizationIds))],
            }));
        }
        props.stream.grant(this.serviceRole, "kinesis:PutRecord");
        props.stream.encryptionKey?.grantEncrypt(this.serviceRole);
        this.destination = new logs.CfnDestination(this, "Destination", {
            destinationName: this.destinationName,
            targetArn: props.stream.streamArn,
            roleArn: this.serviceRole.roleArn,
            destinationPolicy: destinationPolicy(this.destinationArn, allowedSourceAccounts, allowedOrganizationIds),
        });
    }
}
exports.AppTheoryCloudWatchLogsDestination = AppTheoryCloudWatchLogsDestination;
function destinationName(scope, name) {
    const normalized = name === undefined ? aws_cdk_lib_1.Names.uniqueResourceName(scope, { maxLength: 512, separator: "-" }) : name.trim();
    if (!normalized) {
        throw new Error("AppTheoryCloudWatchLogsDestination: destinationName cannot be empty");
    }
    if (aws_cdk_lib_1.Token.isUnresolved(normalized)) {
        return normalized;
    }
    if (!/^[^:*]{1,512}$/.test(normalized)) {
        throw new Error("AppTheoryCloudWatchLogsDestination: destinationName must be 1-512 characters and cannot contain ':' or '*'");
    }
    return normalized;
}
function normalizeUniqueList(values, propName, validate) {
    const normalized = [];
    const seen = new Set();
    for (const value of values) {
        const next = String(value ?? "").trim();
        validate(next, propName);
        if (seen.has(next)) {
            throw new Error(`AppTheoryCloudWatchLogsDestination: duplicate ${propName} entry ${next}`);
        }
        seen.add(next);
        normalized.push(next);
    }
    return normalized;
}
function validateAccountId(accountId, propName) {
    if (!accountId) {
        throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} cannot contain empty values`);
    }
    if (aws_cdk_lib_1.Token.isUnresolved(accountId)) {
        return;
    }
    if (!/^\d{12}$/.test(accountId)) {
        throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} must contain 12-digit AWS account IDs`);
    }
}
function validateOrganizationId(organizationId, propName) {
    if (!organizationId) {
        throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} cannot contain empty values`);
    }
    if (aws_cdk_lib_1.Token.isUnresolved(organizationId)) {
        return;
    }
    if (!/^o-[a-z0-9]{10,32}$/.test(organizationId)) {
        throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} must contain AWS Organization IDs`);
    }
}
function servicePrincipalWithConditions(conditions) {
    return new iam.ServicePrincipal("logs.amazonaws.com", { conditions });
}
function sourceArnTrustConditions(scope, allowedSourceAccounts) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const accounts = [stack.account, ...allowedSourceAccounts];
    const seen = new Set();
    const sourceArns = [];
    for (const account of accounts) {
        if (seen.has(account)) {
            continue;
        }
        seen.add(account);
        sourceArns.push(stack.formatArn({
            service: "logs",
            account,
            resource: "*",
        }));
    }
    return {
        StringLike: {
            "aws:SourceArn": sourceArns,
        },
    };
}
function sourceOrgTrustConditions(allowedOrganizationIds) {
    return {
        StringEquals: {
            "aws:SourceOrgID": allowedOrganizationIds,
        },
    };
}
function destinationPolicy(destinationArn, allowedSourceAccounts, allowedOrganizationIds) {
    const statements = [];
    if (allowedSourceAccounts.length > 0) {
        statements.push({
            Sid: "AllowSourceAccounts",
            Effect: "Allow",
            Principal: { AWS: allowedSourceAccounts },
            Action: "logs:PutSubscriptionFilter",
            Resource: destinationArn,
        });
    }
    if (allowedOrganizationIds.length > 0) {
        statements.push({
            Sid: "AllowSourceOrganizations",
            Effect: "Allow",
            Principal: "*",
            Action: "logs:PutSubscriptionFilter",
            Resource: destinationArn,
            Condition: {
                StringEquals: {
                    "aws:PrincipalOrgID": allowedOrganizationIds,
                },
            },
        });
    }
    return JSON.stringify({
        Version: "2012-10-17",
        Statement: statements,
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWR3YXRjaC1sb2dzLWRlc3RpbmF0aW9uLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2xvdWR3YXRjaC1sb2dzLWRlc3RpbmF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkQ7QUFDN0QseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUF1Q3ZDOzs7Ozs7R0FNRztBQUNILE1BQWEsa0NBQW1DLFNBQVEsc0JBQVM7O0lBQy9EOztPQUVHO0lBQ2EsV0FBVyxDQUFzQjtJQUVqRDs7T0FFRztJQUNhLFdBQVcsQ0FBVztJQUV0Qzs7T0FFRztJQUNhLGNBQWMsQ0FBUztJQUV2Qzs7T0FFRztJQUNhLGVBQWUsQ0FBUztJQUV4QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQThDO1FBQ3RGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxxQkFBcUIsR0FBRyxtQkFBbUIsQ0FDL0MsS0FBSyxDQUFDLHFCQUFxQixJQUFJLEVBQUUsRUFDakMsdUJBQXVCLEVBQ3ZCLGlCQUFpQixDQUNsQixDQUFDO1FBQ0YsTUFBTSxzQkFBc0IsR0FBRyxtQkFBbUIsQ0FDaEQsS0FBSyxDQUFDLHNCQUFzQixJQUFJLEVBQUUsRUFDbEMsd0JBQXdCLEVBQ3hCLHNCQUFzQixDQUN2QixDQUFDO1FBRUYsSUFBSSxxQkFBcUIsQ0FBQyxNQUFNLEtBQUssQ0FBQyxJQUFJLHNCQUFzQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUM5RSxNQUFNLElBQUksS0FBSyxDQUNiLGlHQUFpRyxDQUNsRyxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUM7UUFDcEUsSUFBSSxDQUFDLGNBQWMsR0FBRyxtQkFBSyxDQUFDLEVB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LFVBQVUsR0FBc0IsRUFBRSxDQUFDO0lBRXpDLElBQUkscUJBQXFCLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3JDLFVBQVUsQ0FBQyxJQUFJLENBQUM7WUFDZCxHQUFHLEVBQUUscUJBQXFCO1lBQzFCLE1BQU0sRUFBRSxPQUFPO1lBQ2YsU0FBUyxFQUFFLEVBQUUsR0FBRyxFQUFFLHFCQUFxQixFQUFFO1lBQ3pDLE1BQU0sRUFBRSw0QkFBNEI7WUFDcEMsUUFBUSxFQUFFLGNBQWM7U0FDekIsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELElBQUksc0JBQXNCLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RDLFVBQVUsQ0FBQyxJQUFJLENBQUM7WUFDZCxHQUFHLEVBQUUsMEJBQTBCO1lBQy9CLE1BQU0sRUFBRSxPQUFPO1lBQ2YsU0FBUyxFQUFFLEdBQUc7WUFDZCxNQUFNLEVBQUUsNEJBQTRCO1lBQ3BDLFFBQVEsRUFBRSxjQUFjO1lBQ3hCLFNBQVMsRUFBRTtnQkFDVCxZQUFZLEVBQUU7b0JBQ1osb0JBQW9CLEVBQUUsc0JBQXNCO2lCQUM3QzthQUNGO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNwQixPQUFPLEVBQUUsWUFBWTtRQUNyQixTQUFTLEVBQUUsVUFBVTtLQUN0QixDQUFDLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgQXJuRm9ybWF0LCBOYW1lcywgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMga2luZXNpcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWtpbmVzaXNcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeUNsb3VkV2F0Y2hMb2dzRGVzdGluYXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5Q2xvdWRXYXRjaExvZ3NEZXN0aW5hdGlvblByb3BzIHtcbiAgLyoqXG4gICAqIEtpbmVzaXMgRGF0YSBTdHJlYW0gdGhhdCByZWNlaXZlcyBDbG91ZFdhdGNoIExvZ3Mgc3Vic2NyaXB0aW9uIHJlY29yZHMuXG4gICAqL1xuICByZWFkb25seSBzdHJlYW06IGtpbmVzaXMuSVN0cmVhbTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgcGh5c2ljYWwgQ2xvdWRXYXRjaCBMb2dzIGRlc3RpbmF0aW9uIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gZGV0ZXJtaW5pc3RpYyBuYW1lIGRlcml2ZWQgZnJvbSB0aGUgY29uc3RydWN0IHBhdGhcbiAgICovXG4gIHJlYWRvbmx5IGRlc3RpbmF0aW9uTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRXhwbGljaXQgQVdTIGFjY291bnQgSURzIGFsbG93ZWQgdG8gY3JlYXRlIHN1YnNjcmlwdGlvbiBmaWx0ZXJzIGFnYWluc3QgdGhpcyBkZXN0aW5hdGlvbi5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGFsbG93ZWQgc291cmNlIGFjY291bnQgb3Igb3JnYW5pemF0aW9uIElEIGlzIHJlcXVpcmVkLiBBcHBUaGVvcnkgZG9lcyBub3RcbiAgICogc3ludGhlc2l6ZSBhIGJyb2FkIGRlZmF1bHQgZGVzdGluYXRpb24gcG9saWN5LlxuICAgKlxuICAgKiBAZGVmYXVsdCBbXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dlZFNvdXJjZUFjY291bnRzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0IEFXUyBPcmdhbml6YXRpb25zIElEcyBhbGxvd2VkIHRvIGNyZWF0ZSBzdWJzY3JpcHRpb24gZmlsdGVycyBhZ2FpbnN0IHRoaXMgZGVzdGluYXRpb24uXG4gICAqXG4gICAqIE9yZ2FuaXphdGlvbiBlbnRyaWVzIHVzZSBhIHdpbGRjYXJkIHByaW5jaXBhbCBvbmx5IHdpdGggYW4gYGF3czpQcmluY2lwYWxPcmdJRGAgY29uZGl0aW9uLlxuICAgKiBBdCBsZWFzdCBvbmUgYWxsb3dlZCBzb3VyY2UgYWNjb3VudCBvciBvcmdhbml6YXRpb24gSUQgaXMgcmVxdWlyZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IFtdXG4gICAqL1xuICByZWFkb25seSBhbGxvd2VkT3JnYW5pemF0aW9uSWRzPzogc3RyaW5nW107XG59XG5cbi8qKlxuICogQ2xvdWRXYXRjaCBMb2dzIGRlc3RpbmF0aW9uIHRoYXQgZGVsaXZlcnMgc3Vic2NyaXB0aW9uIHJlY29yZHMgdG8gS2luZXNpcy5cbiAqXG4gKiBUaGUgY29uc3RydWN0IG93bnMgdGhlIGRlc3RpbmF0aW9uLCB0aGUgQ2xvdWRXYXRjaCBMb2dzIHNlcnZpY2Ugcm9sZSwgYW5kIGEgZmFpbC1jbG9zZWRcbiAqIGRlc3RpbmF0aW9uIHBvbGljeS4gU3Vic2NyaXB0aW9uIGZpbHRlciB3cml0ZXJzIG11c3QgYmUgZXhwbGljaXRseSBhbGxvd2VkIGJ5IHNvdXJjZSBhY2NvdW50XG4gKiBhbmQvb3IgQVdTIE9yZ2FuaXphdGlvbiBJRDsgbm8gdW5jb25zdHJhaW5lZCB3aWxkY2FyZCBwcmluY2lwYWwgaXMgc3ludGhlc2l6ZWQuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSBDbG91ZFdhdGNoIExvZ3MgZGVzdGluYXRpb24gcmVzb3VyY2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZGVzdGluYXRpb246IGxvZ3MuQ2ZuRGVzdGluYXRpb247XG5cbiAgLyoqXG4gICAqIElBTSByb2xlIGFzc3VtZWQgYnkgQ2xvdWRXYXRjaCBMb2dzIHRvIHdyaXRlIHJlY29yZHMgdG8gdGhlIHRhcmdldCBzdHJlYW0uXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2VydmljZVJvbGU6IGlhbS5Sb2xlO1xuXG4gIC8qKlxuICAgKiBUaGUgZGVzdGluYXRpb24gQVJOLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlc3RpbmF0aW9uQXJuOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBkZXN0aW5hdGlvbiBuYW1lLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlc3RpbmF0aW9uTmFtZTogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgYWxsb3dlZFNvdXJjZUFjY291bnRzID0gbm9ybWFsaXplVW5pcXVlTGlzdChcbiAgICAgIHByb3BzLmFsbG93ZWRTb3VyY2VBY2NvdW50cyA/PyBbXSxcbiAgICAgIFwiYWxsb3dlZFNvdXJjZUFjY291bnRzXCIsXG4gICAgICB2YWxpZGF0ZUFjY291bnRJZCxcbiAgICApO1xuICAgIGNvbnN0IGFsbG93ZWRPcmdhbml6YXRpb25JZHMgPSBub3JtYWxpemVVbmlxdWVMaXN0KFxuICAgICAgcHJvcHMuYWxsb3dlZE9yZ2FuaXphdGlvbklkcyA/PyBbXSxcbiAgICAgIFwiYWxsb3dlZE9yZ2FuaXphdGlvbklkc1wiLFxuICAgICAgdmFsaWRhdGVPcmdhbml6YXRpb25JZCxcbiAgICApO1xuXG4gICAgaWYgKGFsbG93ZWRTb3VyY2VBY2NvdW50cy5sZW5ndGggPT09IDAgJiYgYWxsb3dlZE9yZ2FuaXphdGlvbklkcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uIHJlcXVpcmVzIGFsbG93ZWRTb3VyY2VBY2NvdW50cyBhbmQvb3IgYWxsb3dlZE9yZ2FuaXphdGlvbklkc1wiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLmRlc3RpbmF0aW9uTmFtZSA9IGRlc3RpbmF0aW9uTmFtZSh0aGlzLCBwcm9wcy5kZXN0aW5hdGlvbk5hbWUpO1xuICAgIHRoaXMuZGVzdGluYXRpb25Bcm4gPSBTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgc2VydmljZTogXCJsb2dzXCIsXG4gICAgICByZXNvdXJjZTogXCJkZXN0aW5hdGlvblwiLFxuICAgICAgcmVzb3VyY2VOYW1lOiB0aGlzLmRlc3RpbmF0aW9uTmFtZSxcbiAgICAgIGFybkZvcm1hdDogQXJuRm9ybWF0LkNPTE9OX1JFU09VUkNFX05BTUUsXG4gICAgfSk7XG5cbiAgICB0aGlzLnNlcnZpY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiU2VydmljZVJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBzZXJ2aWNlUHJpbmNpcGFsV2l0aENvbmRpdGlvbnMoc291cmNlQXJuVHJ1c3RDb25kaXRpb25zKHRoaXMsIGFsbG93ZWRTb3VyY2VBY2NvdW50cykpLFxuICAgIH0pO1xuXG4gICAgaWYgKGFsbG93ZWRPcmdhbml6YXRpb25JZHMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5zZXJ2aWNlUm9sZS5hc3N1bWVSb2xlUG9saWN5Py5hZGRTdGF0ZW1lbnRzKFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgYWN0aW9uczogW1wic3RzOkFzc3VtZVJvbGVcIl0sXG4gICAgICAgICAgcHJpbmNpcGFsczogW3NlcnZpY2VQcmluY2lwYWxXaXRoQ29uZGl0aW9ucyhzb3VyY2VPcmdUcnVzdENvbmRpdGlvbnMoYWxsb3dlZE9yZ2FuaXphdGlvbklkcykpXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH1cblxuICAgIHByb3BzLnN0cmVhbS5ncmFudCh0aGlzLnNlcnZpY2VSb2xlLCBcImtpbmVzaXM6UHV0UmVjb3JkXCIpO1xuICAgIHByb3BzLnN0cmVhbS5lbmNyeXB0aW9uS2V5Py5ncmFudEVuY3J5cHQodGhpcy5zZXJ2aWNlUm9sZSk7XG5cbiAgICB0aGlzLmRlc3RpbmF0aW9uID0gbmV3IGxvZ3MuQ2ZuRGVzdGluYXRpb24odGhpcywgXCJEZXN0aW5hdGlvblwiLCB7XG4gICAgICBkZXN0aW5hdGlvbk5hbWU6IHRoaXMuZGVzdGluYXRpb25OYW1lLFxuICAgICAgdGFyZ2V0QXJuOiBwcm9wcy5zdHJlYW0uc3RyZWFtQXJuLFxuICAgICAgcm9sZUFybjogdGhpcy5zZXJ2aWNlUm9sZS5yb2xlQXJuLFxuICAgICAgZGVzdGluYXRpb25Qb2xpY3k6IGRlc3RpbmF0aW9uUG9saWN5KHRoaXMuZGVzdGluYXRpb25Bcm4sIGFsbG93ZWRTb3VyY2VBY2NvdW50cywgYWxsb3dlZE9yZ2FuaXphdGlvbklkcyksXG4gICAgfSk7XG4gIH1cbn1cblxudHlwZSBWYWxpZGF0b3IgPSAodmFsdWU6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZykgPT4gdm9pZDtcblxudHlwZSBQb2xpY3lTdGF0ZW1lbnQgPSB7XG4gIFNpZDogc3RyaW5nO1xuICBFZmZlY3Q6IFwiQWxsb3dcIjtcbiAgUHJpbmNpcGFsOiBcIipcIiB8IHsgQVdTOiBzdHJpbmdbXSB9O1xuICBBY3Rpb246IFwibG9nczpQdXRTdWJzY3JpcHRpb25GaWx0ZXJcIjtcbiAgUmVzb3VyY2U6IHN0cmluZztcbiAgQ29uZGl0aW9uPzoge1xuICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgXCJhd3M6UHJpbmNpcGFsT3JnSURcIjogc3RyaW5nW107XG4gICAgfTtcbiAgfTtcbn07XG5cbmZ1bmN0aW9uIGRlc3RpbmF0aW9uTmFtZShzY29wZTogQ29uc3RydWN0LCBuYW1lPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9XG4gICAgbmFtZSA9PT0gdW5kZWZpbmVkID8gTmFtZXMudW5pcXVlUmVzb3VyY2VOYW1lKHNjb3BlLCB7IG1heExlbmd0aDogNTEyLCBzZXBhcmF0b3I6IFwiLVwiIH0pIDogbmFtZS50cmltKCk7XG5cbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5Q2xvdWRXYXRjaExvZ3NEZXN0aW5hdGlvbjogZGVzdGluYXRpb25OYW1lIGNhbm5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuXG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQobm9ybWFsaXplZCkpIHtcbiAgICByZXR1cm4gbm9ybWFsaXplZDtcbiAgfVxuXG4gIGlmICghL15bXjoqXXsxLDUxMn0kLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uOiBkZXN0aW5hdGlvbk5hbWUgbXVzdCBiZSAxLTUxMiBjaGFyYWN0ZXJzIGFuZCBjYW5ub3QgY29udGFpbiAnOicgb3IgJyonXCIsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVVbmlxdWVMaXN0KHZhbHVlczogc3RyaW5nW10sIHByb3BOYW1lOiBzdHJpbmcsIHZhbGlkYXRlOiBWYWxpZGF0b3IpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGNvbnN0IG5leHQgPSBTdHJpbmcodmFsdWUgPz8gXCJcIikudHJpbSgpO1xuICAgIHZhbGlkYXRlKG5leHQsIHByb3BOYW1lKTtcblxuICAgIGlmIChzZWVuLmhhcyhuZXh0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uOiBkdXBsaWNhdGUgJHtwcm9wTmFtZX0gZW50cnkgJHtuZXh0fWApO1xuICAgIH1cblxuICAgIHNlZW4uYWRkKG5leHQpO1xuICAgIG5vcm1hbGl6ZWQucHVzaChuZXh0KTtcbiAgfVxuXG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUFjY291bnRJZChhY2NvdW50SWQ6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIWFjY291bnRJZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5Q2xvdWRXYXRjaExvZ3NEZXN0aW5hdGlvbjogJHtwcm9wTmFtZX0gY2Fubm90IGNvbnRhaW4gZW1wdHkgdmFsdWVzYCk7XG4gIH1cblxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKGFjY291bnRJZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIS9eXFxkezEyfSQvLnRlc3QoYWNjb3VudElkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5Q2xvdWRXYXRjaExvZ3NEZXN0aW5hdGlvbjogJHtwcm9wTmFtZX0gbXVzdCBjb250YWluIDEyLWRpZ2l0IEFXUyBhY2NvdW50IElEc2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlT3JnYW5pemF0aW9uSWQob3JnYW5pemF0aW9uSWQ6IHN0cmluZywgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIW9yZ2FuaXphdGlvbklkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlDbG91ZFdhdGNoTG9nc0Rlc3RpbmF0aW9uOiAke3Byb3BOYW1lfSBjYW5ub3QgY29udGFpbiBlbXB0eSB2YWx1ZXNgKTtcbiAgfVxuXG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQob3JnYW5pemF0aW9uSWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCEvXm8tW2EtejAtOV17MTAsMzJ9JC8udGVzdChvcmdhbml6YXRpb25JZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeUNsb3VkV2F0Y2hMb2dzRGVzdGluYXRpb246ICR7cHJvcE5hbWV9IG11c3QgY29udGFpbiBBV1MgT3JnYW5pemF0aW9uIElEc2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNlcnZpY2VQcmluY2lwYWxXaXRoQ29uZGl0aW9ucyhcbiAgY29uZGl0aW9uczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgc3RyaW5nW10+Pixcbik6IGlhbS5TZXJ2aWNlUHJpbmNpcGFsIHtcbiAgcmV0dXJuIG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImxvZ3MuYW1hem9uYXdzLmNvbVwiLCB7IGNvbmRpdGlvbnMgfSk7XG59XG5cbmZ1bmN0aW9uIHNvdXJjZUFyblRydXN0Q29uZGl0aW9ucyhcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgYWxsb3dlZFNvdXJjZUFjY291bnRzOiBzdHJpbmdbXSxcbik6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPj4ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3QgYWNjb3VudHMgPSBbc3RhY2suYWNjb3VudCwgLi4uYWxsb3dlZFNvdXJjZUFjY291bnRzXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBzb3VyY2VBcm5zOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgYWNjb3VudCBvZiBhY2NvdW50cykge1xuICAgIGlmIChzZWVuLmhhcyhhY2NvdW50KSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlZW4uYWRkKGFjY291bnQpO1xuICAgIHNvdXJjZUFybnMucHVzaChcbiAgICAgIHN0YWNrLmZvcm1hdEFybih7XG4gICAgICAgIHNlcnZpY2U6IFwibG9nc1wiLFxuICAgICAgICBhY2NvdW50LFxuICAgICAgICByZXNvdXJjZTogXCIqXCIsXG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBTdHJpbmdMaWtlOiB7XG4gICAgICBcImF3czpTb3VyY2VBcm5cIjogc291cmNlQXJucyxcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBzb3VyY2VPcmdUcnVzdENvbmRpdGlvbnMoXG4gIGFsbG93ZWRPcmdhbml6YXRpb25JZHM6IHN0cmluZ1tdLFxuKTogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nW10+PiB7XG4gIHJldHVybiB7XG4gICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICBcImF3czpTb3VyY2VPcmdJRFwiOiBhbGxvd2VkT3JnYW5pemF0aW9uSWRzLFxuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGRlc3RpbmF0aW9uUG9saWN5KFxuICBkZXN0aW5hdGlvbkFybjogc3RyaW5nLFxuICBhbGxvd2VkU291cmNlQWNjb3VudHM6IHN0cmluZ1tdLFxuICBhbGxvd2VkT3JnYW5pemF0aW9uSWRzOiBzdHJpbmdbXSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHN0YXRlbWVudHM6IFBvbGljeVN0YXRlbWVudFtdID0gW107XG5cbiAgaWYgKGFsbG93ZWRTb3VyY2VBY2NvdW50cy5sZW5ndGggPiAwKSB7XG4gICAgc3RhdGVtZW50cy5wdXNoKHtcbiAgICAgIFNpZDogXCJBbGxvd1NvdXJjZUFjY291bnRzXCIsXG4gICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgIFByaW5jaXBhbDogeyBBV1M6IGFsbG93ZWRTb3VyY2VBY2NvdW50cyB9LFxuICAgICAgQWN0aW9uOiBcImxvZ3M6UHV0U3Vic2NyaXB0aW9uRmlsdGVyXCIsXG4gICAgICBSZXNvdXJjZTogZGVzdGluYXRpb25Bcm4sXG4gICAgfSk7XG4gIH1cblxuICBpZiAoYWxsb3dlZE9yZ2FuaXphdGlvbklkcy5sZW5ndGggPiAwKSB7XG4gICAgc3RhdGVtZW50cy5wdXNoKHtcbiAgICAgIFNpZDogXCJBbGxvd1NvdXJjZU9yZ2FuaXphdGlvbnNcIixcbiAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgUHJpbmNpcGFsOiBcIipcIixcbiAgICAgIEFjdGlvbjogXCJsb2dzOlB1dFN1YnNjcmlwdGlvbkZpbHRlclwiLFxuICAgICAgUmVzb3VyY2U6IGRlc3RpbmF0aW9uQXJuLFxuICAgICAgQ29uZGl0aW9uOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgIFwiYXdzOlByaW5jaXBhbE9yZ0lEXCI6IGFsbG93ZWRPcmdhbml6YXRpb25JZHMsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIixcbiAgICBTdGF0ZW1lbnQ6IHN0YXRlbWVudHMsXG4gIH0pO1xufVxuIl19