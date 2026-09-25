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
exports.AppTheoryKmsKey = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const kms = __importStar(require("aws-cdk-lib/aws-kms"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const constructs_1 = require("constructs");
class AppTheoryKmsKey extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKmsKey", version: "4.4.2" };
    key;
    alias;
    ssmParameter;
    keyArn;
    keyId;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const keySpec = props.keySpec ?? kms.KeySpec.SYMMETRIC_DEFAULT;
        const keyUsage = props.keyUsage ??
            (keySpec === kms.KeySpec.HMAC_256 ? kms.KeyUsage.GENERATE_VERIFY_MAC : kms.KeyUsage.ENCRYPT_DECRYPT);
        const enableKeyRotation = props.enableKeyRotation ?? (keySpec === kms.KeySpec.SYMMETRIC_DEFAULT ? true : false);
        const pendingWindow = props.pendingWindow ?? aws_cdk_lib_1.Duration.days(30);
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const multiRegion = props.multiRegion ?? false;
        const isReplicaKey = props.isReplicaKey ?? false;
        const enableSsmParameter = props.enableSsmParameter ?? false;
        let tagTarget;
        if (isReplicaKey) {
            const primaryKeyArn = String(props.primaryKeyArn ?? "").trim();
            if (!primaryKeyArn) {
                throw new Error("AppTheoryKmsKey replica requires props.primaryKeyArn");
            }
            const keyPolicy = props.customKeyPolicy ? props.customKeyPolicy.toJSON() : createDefaultReplicaKeyPolicy(this);
            const replicaKey = new kms.CfnReplicaKey(this, "ReplicaKey", {
                primaryKeyArn,
                keyPolicy,
                description: props.description,
                enabled: true,
            });
            this.key = kms.Key.fromKeyArn(this, "ImportedReplicaKey", replicaKey.attrArn);
            this.keyArn = replicaKey.attrArn;
            this.keyId = replicaKey.attrKeyId;
            tagTarget = replicaKey;
        }
        else {
            const key = new kms.Key(this, "Key", {
                description: props.description,
                keySpec,
                keyUsage,
                enableKeyRotation,
                removalPolicy,
                pendingWindow,
                multiRegion,
                policy: props.customKeyPolicy,
            });
            this.key = key;
            this.keyArn = key.keyArn;
            this.keyId = key.keyId;
            tagTarget = key;
        }
        if (props.aliasName) {
            this.alias = new kms.Alias(this, "Alias", {
                aliasName: props.aliasName,
                targetKey: this.key,
            });
        }
        if (props.grantEncryptDecrypt) {
            for (const grantee of props.grantEncryptDecrypt) {
                this.key.grantEncryptDecrypt(grantee);
            }
        }
        if (props.grantGenerateMac) {
            for (const grantee of props.grantGenerateMac) {
                this.key.grant(grantee, "kms:GenerateMac", "kms:VerifyMac");
            }
        }
        if (enableSsmParameter && props.ssmParameterPath) {
            this.ssmParameter = new ssm.StringParameter(this, "SSMParameter", {
                parameterName: props.ssmParameterPath,
                stringValue: this.keyArn,
                description: `KMS Key ARN for ${props.description ?? id}`,
                tier: ssm.ParameterTier.STANDARD,
            });
        }
        if (tagTarget) {
            aws_cdk_lib_1.Tags.of(tagTarget).add("Framework", "AppTheory");
            aws_cdk_lib_1.Tags.of(tagTarget).add("Component", "KMS");
            if (props.tags) {
                for (const [key, value] of Object.entries(props.tags)) {
                    aws_cdk_lib_1.Tags.of(tagTarget).add(key, value);
                }
            }
        }
    }
}
exports.AppTheoryKmsKey = AppTheoryKmsKey;
function createDefaultReplicaKeyPolicy(scope) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const accountId = stack.account;
    const region = stack.region;
    return {
        Version: "2012-10-17",
        Statement: [
            {
                Sid: "Enable IAM User Permissions",
                Effect: "Allow",
                Principal: {
                    AWS: `arn:aws:iam::${accountId}:root`,
                },
                Action: "kms:*",
                Resource: "*",
            },
            {
                Sid: "Allow use of the key",
                Effect: "Allow",
                Principal: {
                    AWS: `arn:aws:iam::${accountId}:root`,
                },
                Action: [
                    "kms:Encrypt",
                    "kms:Decrypt",
                    "kms:ReEncrypt*",
                    "kms:GenerateDataKey*",
                    "kms:CreateGrant",
                    "kms:DescribeKey",
                    "kms:GenerateMac",
                    "kms:VerifyMac",
                ],
                Resource: "*",
            },
            {
                Sid: "Allow CloudWatch Logs",
                Effect: "Allow",
                Principal: {
                    Service: `logs.${region}.amazonaws.com`,
                },
                Action: [
                    "kms:Encrypt",
                    "kms:Decrypt",
                    "kms:ReEncrypt*",
                    "kms:GenerateDataKey*",
                    "kms:CreateGrant",
                    "kms:DescribeKey",
                ],
                Resource: "*",
            },
        ],
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia21zLWtleS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImttcy1rZXkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFtRTtBQUVuRSx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLDJDQUF1QztBQTJCdkMsTUFBYSxlQUFnQixTQUFRLHNCQUFTOztJQUM1QixHQUFHLENBQVc7SUFDZCxLQUFLLENBQWE7SUFDbEIsWUFBWSxDQUF1QjtJQUNuQyxNQUFNLENBQVM7SUFDZixLQUFLLENBQVM7SUFFOUIsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUE4QixFQUFFO1FBQ3hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLGlCQUFpQixDQUFDO1FBQy9ELE1BQU0sUUFBUSxHQUNaLEtBQUssQ0FBQyxRQUFRO1lBQ2QsQ0FBQyxPQUFPLEtBQUssR0FBRyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLENBQUM7UUFDdkcsTUFBTSxpQkFBaUIsR0FDckIsS0FBSyxDQUFDLGlCQUFpQixJQUFJLENBQUMsT0FBTyxLQUFLLEdBQUcsQ0FBQyxPQUFPLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDeEYsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSxzQkFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMvRCxNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLDJCQUFhLENBQUMsTUFBTSxDQUFD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TUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUU1QixPQUFPO1FBQ0wsT0FBTyxFQUFFLFlBQVk7UUFDckIsU0FBUyxFQUFFO1lBQ1Q7Z0JBQ0UsR0FBRyxFQUFFLDZCQUE2QjtnQkFDbEMsTUFBTSxFQUFFLE9BQU87Z0JBQ2YsU0FBUyxFQUFFO29CQUNULEdBQUcsRUFBRSxnQkFBZ0IsU0FBUyxPQUFPO2lCQUN0QztnQkFDRCxNQUFNLEVBQUUsT0FBTztnQkFDZixRQUFRLEVBQUUsR0FBRzthQUNkO1lBQ0Q7Z0JBQ0UsR0FBRyxFQUFFLHNCQUFzQjtnQkFDM0IsTUFBTSxFQUFFLE9BQU87Z0JBQ2YsU0FBUyxFQUFFO29CQUNULEdBQUcsRUFBRSxnQkFBZ0IsU0FBUyxPQUFPO2lCQUN0QztnQkFDRCxNQUFNLEVBQUU7b0JBQ04sYUFBYTtvQkFDYixhQUFhO29CQUNiLGdCQUFnQjtvQkFDaEIsc0JBQXNCO29CQUN0QixpQkFBaUI7b0JBQ2pCLGlCQUFpQjtvQkFDakIsaUJBQWlCO29CQUNqQixlQUFlO2lCQUNoQjtnQkFDRCxRQUFRLEVBQUUsR0FBRzthQUNkO1lBQ0Q7Z0JBQ0UsR0FBRyxFQUFFLHVCQUF1QjtnQkFDNUIsTUFBTSxFQUFFLE9BQU87Z0JBQ2YsU0FBUyxFQUFFO29CQUNULE9BQU8sRUFBRSxRQUFRLE1BQU0sZ0JBQWdCO2lCQUN4QztnQkFDRCxNQUFNLEVBQUU7b0JBQ04sYUFBYTtvQkFDYixhQUFhO29CQUNiLGdCQUFnQjtvQkFDaEIsc0JBQXNCO29CQUN0QixpQkFBaUI7b0JBQ2pCLGlCQUFpQjtpQkFDbEI7Z0JBQ0QsUUFBUSxFQUFFLEdBQUc7YUFDZDtTQUNGO0tBQ0YsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRhZ3MgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBzc20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1zc21cIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5S21zS2V5UHJvcHMge1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgcmVhZG9ubHkgYWxpYXNOYW1lPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IHByaW1hcnlLZXlBcm4/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFkbWluaXN0cmF0b3JBcm4/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGN1c3RvbUtleVBvbGljeT86IGlhbS5Qb2xpY3lEb2N1bWVudDtcbiAgcmVhZG9ubHkgc3NtUGFyYW1ldGVyUGF0aD86IHN0cmluZztcbiAgcmVhZG9ubHkgdGFncz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIHJlYWRvbmx5IGVuYWJsZWRSZWdpb25zPzogc3RyaW5nW107XG5cbiAgcmVhZG9ubHkgbXVsdGlSZWdpb24/OiBib29sZWFuO1xuICByZWFkb25seSBpc1JlcGxpY2FLZXk/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVLZXlSb3RhdGlvbj86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGVuYWJsZVNzbVBhcmFtZXRlcj86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZ3JhbnRFbmNyeXB0RGVjcnlwdD86IGlhbS5JR3JhbnRhYmxlW107XG4gIHJlYWRvbmx5IGdyYW50R2VuZXJhdGVNYWM/OiBpYW0uSUdyYW50YWJsZVtdO1xuXG4gIHJlYWRvbmx5IGtleVNwZWM/OiBrbXMuS2V5U3BlYztcbiAgcmVhZG9ubHkga2V5VXNhZ2U/OiBrbXMuS2V5VXNhZ2U7XG4gIHJlYWRvbmx5IHBlbmRpbmdXaW5kb3c/OiBEdXJhdGlvbjtcbiAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlLbXNLZXkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkga2V5OiBrbXMuSUtleTtcbiAgcHVibGljIHJlYWRvbmx5IGFsaWFzPzoga21zLkFsaWFzO1xuICBwdWJsaWMgcmVhZG9ubHkgc3NtUGFyYW1ldGVyPzogc3NtLlN0cmluZ1BhcmFtZXRlcjtcbiAgcHVibGljIHJlYWRvbmx5IGtleUFybjogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkga2V5SWQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5S21zS2V5UHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBrZXlTcGVjID0gcHJvcHMua2V5U3BlYyA/PyBrbXMuS2V5U3BlYy5TWU1NRVRSSUNfREVGQVVMVDtcbiAgICBjb25zdCBrZXlVc2FnZSA9XG4gICAgICBwcm9wcy5rZXlVc2FnZSA/P1xuICAgICAgKGtleVNwZWMgPT09IGttcy5LZXlTcGVjLkhNQUNfMjU2ID8ga21zLktleVVzYWdlLkdFTkVSQVRFX1ZFUklGWV9NQUMgOiBrbXMuS2V5VXNhZ2UuRU5DUllQVF9ERUNSWVBUKTtcbiAgICBjb25zdCBlbmFibGVLZXlSb3RhdGlvbiA9XG4gICAgICBwcm9wcy5lbmFibGVLZXlSb3RhdGlvbiA/PyAoa2V5U3BlYyA9PT0ga21zLktleVNwZWMuU1lNTUVUUklDX0RFRkFVTFQgPyB0cnVlIDogZmFsc2UpO1xuICAgIGNvbnN0IHBlbmRpbmdXaW5kb3cgPSBwcm9wcy5wZW5kaW5nV2luZG93ID8/IER1cmF0aW9uLmRheXMoMzApO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IG11bHRpUmVnaW9uID0gcHJvcHMubXVsdGlSZWdpb24gPz8gZmFsc2U7XG4gICAgY29uc3QgaXNSZXBsaWNhS2V5ID0gcHJvcHMuaXNSZXBsaWNhS2V5ID8/IGZhbHNlO1xuICAgIGNvbnN0IGVuYWJsZVNzbVBhcmFtZXRlciA9IHByb3BzLmVuYWJsZVNzbVBhcmFtZXRlciA/PyBmYWxzZTtcblxuICAgIGxldCB0YWdUYXJnZXQ6IENvbnN0cnVjdCB8IHVuZGVmaW5lZDtcblxuICAgIGlmIChpc1JlcGxpY2FLZXkpIHtcbiAgICAgIGNvbnN0IHByaW1hcnlLZXlBcm4gPSBTdHJpbmcocHJvcHMucHJpbWFyeUtleUFybiA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoIXByaW1hcnlLZXlBcm4pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5S21zS2V5IHJlcGxpY2EgcmVxdWlyZXMgcHJvcHMucHJpbWFyeUtleUFyblwiKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qga2V5UG9saWN5ID0gcHJvcHMuY3VzdG9tS2V5UG9saWN5ID8gcHJvcHMuY3VzdG9tS2V5UG9saWN5LnRvSlNPTigpIDogY3JlYXRlRGVmYXVsdFJlcGxpY2FLZXlQb2xpY3kodGhpcyk7XG5cbiAgICAgIGNvbnN0IHJlcGxpY2FLZXkgPSBuZXcga21zLkNmblJlcGxpY2FLZXkodGhpcywgXCJSZXBsaWNhS2V5XCIsIHtcbiAgICAgICAgcHJpbWFyeUtleUFybixcbiAgICAgICAga2V5UG9saWN5LFxuICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5rZXkgPSBrbXMuS2V5LmZyb21LZXlBcm4odGhpcywgXCJJbXBvcnRlZFJlcGxpY2FLZXlcIiwgcmVwbGljYUtleS5hdHRyQXJuKTtcbiAgICAgIHRoaXMua2V5QXJuID0gcmVwbGljYUtleS5hdHRyQXJuO1xuICAgICAgdGhpcy5rZXlJZCA9IHJlcGxpY2FLZXkuYXR0cktleUlkO1xuICAgICAgdGFnVGFyZ2V0ID0gcmVwbGljYUtleTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qga2V5ID0gbmV3IGttcy5LZXkodGhpcywgXCJLZXlcIiwge1xuICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24sXG4gICAgICAgIGtleVNwZWMsXG4gICAgICAgIGtleVVzYWdlLFxuICAgICAgICBlbmFibGVLZXlSb3RhdGlvbixcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcGVuZGluZ1dpbmRvdyxcbiAgICAgICAgbXVsdGlSZWdpb24sXG4gICAgICAgIHBvbGljeTogcHJvcHMuY3VzdG9tS2V5UG9saWN5LFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMua2V5ID0ga2V5O1xuICAgICAgdGhpcy5rZXlBcm4gPSBrZXkua2V5QXJuO1xuICAgICAgdGhpcy5rZXlJZCA9IGtleS5rZXlJZDtcbiAgICAgIHRhZ1RhcmdldCA9IGtleTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuYWxpYXNOYW1lKSB7XG4gICAgICB0aGlzLmFsaWFzID0gbmV3IGttcy5BbGlhcyh0aGlzLCBcIkFsaWFzXCIsIHtcbiAgICAgICAgYWxpYXNOYW1lOiBwcm9wcy5hbGlhc05hbWUsXG4gICAgICAgIHRhcmdldEtleTogdGhpcy5rZXksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZ3JhbnRFbmNyeXB0RGVjcnlwdCkge1xuICAgICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50RW5jcnlwdERlY3J5cHQpIHtcbiAgICAgICAgdGhpcy5rZXkuZ3JhbnRFbmNyeXB0RGVjcnlwdChncmFudGVlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZ3JhbnRHZW5lcmF0ZU1hYykge1xuICAgICAgZm9yIChjb25zdCBncmFudGVlIG9mIHByb3BzLmdyYW50R2VuZXJhdGVNYWMpIHtcbiAgICAgICAgdGhpcy5rZXkuZ3JhbnQoZ3JhbnRlZSwgXCJrbXM6R2VuZXJhdGVNYWNcIiwgXCJrbXM6VmVyaWZ5TWFjXCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChlbmFibGVTc21QYXJhbWV0ZXIgJiYgcHJvcHMuc3NtUGFyYW1ldGVyUGF0aCkge1xuICAgICAgdGhpcy5zc21QYXJhbWV0ZXIgPSBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBcIlNTTVBhcmFtZXRlclwiLCB7XG4gICAgICAgIHBhcmFtZXRlck5hbWU6IHByb3BzLnNzbVBhcmFtZXRlclBhdGgsXG4gICAgICAgIHN0cmluZ1ZhbHVlOiB0aGlzLmtleUFybixcbiAgICAgICAgZGVzY3JpcHRpb246IGBLTVMgS2V5IEFSTiBmb3IgJHtwcm9wcy5kZXNjcmlwdGlvbiA/PyBpZH1gLFxuICAgICAgICB0aWVyOiBzc20uUGFyYW1ldGVyVGllci5TVEFOREFSRCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0YWdUYXJnZXQpIHtcbiAgICAgIFRhZ3Mub2YodGFnVGFyZ2V0KS5hZGQoXCJGcmFtZXdvcmtcIiwgXCJBcHBUaGVvcnlcIik7XG4gICAgICBUYWdzLm9mKHRhZ1RhcmdldCkuYWRkKFwiQ29tcG9uZW50XCIsIFwiS01TXCIpO1xuXG4gICAgICBpZiAocHJvcHMudGFncykge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwcm9wcy50YWdzKSkge1xuICAgICAgICAgIFRhZ3Mub2YodGFnVGFyZ2V0KS5hZGQoa2V5LCB2YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlRGVmYXVsdFJlcGxpY2FLZXlQb2xpY3koc2NvcGU6IENvbnN0cnVjdCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IGFjY291bnRJZCA9IHN0YWNrLmFjY291bnQ7XG4gIGNvbnN0IHJlZ2lvbiA9IHN0YWNrLnJlZ2lvbjtcblxuICByZXR1cm4ge1xuICAgIFZlcnNpb246IFwiMjAxMi0xMC0xN1wiLFxuICAgIFN0YXRlbWVudDogW1xuICAgICAge1xuICAgICAgICBTaWQ6IFwiRW5hYmxlIElBTSBVc2VyIFBlcm1pc3Npb25zXCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBQcmluY2lwYWw6IHtcbiAgICAgICAgICBBV1M6IGBhcm46YXdzOmlhbTo6JHthY2NvdW50SWR9OnJvb3RgLFxuICAgICAgICB9LFxuICAgICAgICBBY3Rpb246IFwia21zOipcIixcbiAgICAgICAgUmVzb3VyY2U6IFwiKlwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgU2lkOiBcIkFsbG93IHVzZSBvZiB0aGUga2V5XCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBQcmluY2lwYWw6IHtcbiAgICAgICAgICBBV1M6IGBhcm46YXdzOmlhbTo6JHthY2NvdW50SWR9OnJvb3RgLFxuICAgICAgICB9LFxuICAgICAgICBBY3Rpb246IFtcbiAgICAgICAgICBcImttczpFbmNyeXB0XCIsXG4gICAgICAgICAgXCJrbXM6RGVjcnlwdFwiLFxuICAgICAgICAgIFwia21zOlJlRW5jcnlwdCpcIixcbiAgICAgICAgICBcImttczpHZW5lcmF0ZURhdGFLZXkqXCIsXG4gICAgICAgICAgXCJrbXM6Q3JlYXRlR3JhbnRcIixcbiAgICAgICAgICBcImttczpEZXNjcmliZUtleVwiLFxuICAgICAgICAgIFwia21zOkdlbmVyYXRlTWFjXCIsXG4gICAgICAgICAgXCJrbXM6VmVyaWZ5TWFjXCIsXG4gICAgICAgIF0sXG4gICAgICAgIFJlc291cmNlOiBcIipcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIFNpZDogXCJBbGxvdyBDbG91ZFdhdGNoIExvZ3NcIixcbiAgICAgICAgRWZmZWN0OiBcIkFsbG93XCIsXG4gICAgICAgIFByaW5jaXBhbDoge1xuICAgICAgICAgIFNlcnZpY2U6IGBsb2dzLiR7cmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgfSxcbiAgICAgICAgQWN0aW9uOiBbXG4gICAgICAgICAgXCJrbXM6RW5jcnlwdFwiLFxuICAgICAgICAgIFwia21zOkRlY3J5cHRcIixcbiAgICAgICAgICBcImttczpSZUVuY3J5cHQqXCIsXG4gICAgICAgICAgXCJrbXM6R2VuZXJhdGVEYXRhS2V5KlwiLFxuICAgICAgICAgIFwia21zOkNyZWF0ZUdyYW50XCIsXG4gICAgICAgICAgXCJrbXM6RGVzY3JpYmVLZXlcIixcbiAgICAgICAgXSxcbiAgICAgICAgUmVzb3VyY2U6IFwiKlwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9O1xufVxuIl19