"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryKmsKey = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const kms = require("aws-cdk-lib/aws-kms");
const ssm = require("aws-cdk-lib/aws-ssm");
const constructs_1 = require("constructs");
class AppTheoryKmsKey extends constructs_1.Construct {
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryKmsKey[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKmsKey", version: "0.7.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia21zLWtleS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImttcy1rZXkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBbUU7QUFFbkUsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUMzQywyQ0FBdUM7QUEyQnZDLE1BQWEsZUFBZ0IsU0FBUSxzQkFBUztJQU81QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQThCLEVBQUU7UUFDeEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsT0FBTyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsaUJBQWlCLENBQUM7UUFDL0QsTUFBTSxRQUFRLEdBQ1osS0FBSyxDQUFDLFFBQVE7WUFDZCxDQUFDLE9BQU8sS0FBSyxHQUFHLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUN2RyxNQUFNLGlCQUFpQixHQUNyQixLQUFLLENBQUMsaUJBQWlCLElBQUksQ0FBQyxPQUFPLEtBQUssR0FBRyxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN4RixNQUFNLGFBQWEsR0FBRyxLQUFLLENBQUMsYUFBYSxJQUFJLHNCQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQy9ELE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLElBQUksMkJBQWEsQ0FBQyxNQUFNLENBQUM7UUFDbEUsTUFBTSxXQUFXLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxLQUFLLENBQUM7UUFDL0MsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFlBQVksSUFBSSxLQUFLLENBQUM7UUFDakQsTUFB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Z0JBQ2xDLE1BQU0sRUFBRSxPQUFPO2dCQUNmLFNBQVMsRUFBRTtvQkFDVCxHQUFHLEVBQUUsZ0JBQWdCLFNBQVMsT0FBTztpQkFDdEM7Z0JBQ0QsTUFBTSxFQUFFLE9BQU87Z0JBQ2YsUUFBUSxFQUFFLEdBQUc7YUFDZDtZQUNEO2dCQUNFLEdBQUcsRUFBRSxzQkFBc0I7Z0JBQzNCLE1BQU0sRUFBRSxPQUFPO2dCQUNmLFNBQVMsRUFBRTtvQkFDVCxHQUFHLEVBQUUsZ0JBQWdCLFNBQVMsT0FBTztpQkFDdEM7Z0JBQ0QsTUFBTSxFQUFFO29CQUNOLGFBQWE7b0JBQ2IsYUFBYTtvQkFDYixnQkFBZ0I7b0JBQ2hCLHNCQUFzQjtvQkFDdEIsaUJBQWlCO29CQUNqQixpQkFBaUI7b0JBQ2pCLGlCQUFpQjtvQkFDakIsZUFBZTtpQkFDaEI7Z0JBQ0QsUUFBUSxFQUFFLEdBQUc7YUFDZDtZQUNEO2dCQUNFLEdBQUcsRUFBRSx1QkFBdUI7Z0JBQzVCLE1BQU0sRUFBRSxPQUFPO2dCQUNmLFNBQVMsRUFBRTtvQkFDVCxPQUFPLEVBQUUsUUFBUSxNQUFNLGdCQUFnQjtpQkFDeEM7Z0JBQ0QsTUFBTSxFQUFFO29CQUNOLGFBQWE7b0JBQ2IsYUFBYTtvQkFDYixnQkFBZ0I7b0JBQ2hCLHNCQUFzQjtvQkFDdEIsaUJBQWlCO29CQUNqQixpQkFBaUI7aUJBQ2xCO2dCQUNELFFBQVEsRUFBRSxHQUFHO2FBQ2Q7U0FDRjtLQUNGLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUYWdzIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgc3NtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3NtXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUttc0tleVByb3BzIHtcbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFsaWFzTmFtZT86IHN0cmluZztcblxuICByZWFkb25seSBwcmltYXJ5S2V5QXJuPzogc3RyaW5nO1xuICByZWFkb25seSBhZG1pbmlzdHJhdG9yQXJuPzogc3RyaW5nO1xuICByZWFkb25seSBjdXN0b21LZXlQb2xpY3k/OiBpYW0uUG9saWN5RG9jdW1lbnQ7XG4gIHJlYWRvbmx5IHNzbVBhcmFtZXRlclBhdGg/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRhZ3M/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByZWFkb25seSBlbmFibGVkUmVnaW9ucz86IHN0cmluZ1tdO1xuXG4gIHJlYWRvbmx5IG11bHRpUmVnaW9uPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgaXNSZXBsaWNhS2V5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZW5hYmxlS2V5Um90YXRpb24/OiBib29sZWFuO1xuICByZWFkb25seSBlbmFibGVTc21QYXJhbWV0ZXI/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGdyYW50RW5jcnlwdERlY3J5cHQ/OiBpYW0uSUdyYW50YWJsZVtdO1xuICByZWFkb25seSBncmFudEdlbmVyYXRlTWFjPzogaWFtLklHcmFudGFibGVbXTtcblxuICByZWFkb25seSBrZXlTcGVjPzoga21zLktleVNwZWM7XG4gIHJlYWRvbmx5IGtleVVzYWdlPzoga21zLktleVVzYWdlO1xuICByZWFkb25seSBwZW5kaW5nV2luZG93PzogRHVyYXRpb247XG4gIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5S21zS2V5IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGtleToga21zLklLZXk7XG4gIHB1YmxpYyByZWFkb25seSBhbGlhcz86IGttcy5BbGlhcztcbiAgcHVibGljIHJlYWRvbmx5IHNzbVBhcmFtZXRlcj86IHNzbS5TdHJpbmdQYXJhbWV0ZXI7XG4gIHB1YmxpYyByZWFkb25seSBrZXlBcm46IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGtleUlkOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUttc0tleVByb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qga2V5U3BlYyA9IHByb3BzLmtleVNwZWMgPz8ga21zLktleVNwZWMuU1lNTUVUUklDX0RFRkFVTFQ7XG4gICAgY29uc3Qga2V5VXNhZ2UgPVxuICAgICAgcHJvcHMua2V5VXNhZ2UgPz9cbiAgICAgIChrZXlTcGVjID09PSBrbXMuS2V5U3BlYy5ITUFDXzI1NiA/IGttcy5LZXlVc2FnZS5HRU5FUkFURV9WRVJJRllfTUFDIDoga21zLktleVVzYWdlLkVOQ1JZUFRfREVDUllQVCk7XG4gICAgY29uc3QgZW5hYmxlS2V5Um90YXRpb24gPVxuICAgICAgcHJvcHMuZW5hYmxlS2V5Um90YXRpb24gPz8gKGtleVNwZWMgPT09IGttcy5LZXlTcGVjLlNZTU1FVFJJQ19ERUZBVUxUID8gdHJ1ZSA6IGZhbHNlKTtcbiAgICBjb25zdCBwZW5kaW5nV2luZG93ID0gcHJvcHMucGVuZGluZ1dpbmRvdyA/PyBEdXJhdGlvbi5kYXlzKDMwKTtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBtdWx0aVJlZ2lvbiA9IHByb3BzLm11bHRpUmVnaW9uID8/IGZhbHNlO1xuICAgIGNvbnN0IGlzUmVwbGljYUtleSA9IHByb3BzLmlzUmVwbGljYUtleSA/PyBmYWxzZTtcbiAgICBjb25zdCBlbmFibGVTc21QYXJhbWV0ZXIgPSBwcm9wcy5lbmFibGVTc21QYXJhbWV0ZXIgPz8gZmFsc2U7XG5cbiAgICBsZXQgdGFnVGFyZ2V0OiBDb25zdHJ1Y3QgfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAoaXNSZXBsaWNhS2V5KSB7XG4gICAgICBjb25zdCBwcmltYXJ5S2V5QXJuID0gU3RyaW5nKHByb3BzLnByaW1hcnlLZXlBcm4gPz8gXCJcIikudHJpbSgpO1xuICAgICAgaWYgKCFwcmltYXJ5S2V5QXJuKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUttc0tleSByZXBsaWNhIHJlcXVpcmVzIHByb3BzLnByaW1hcnlLZXlBcm5cIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGtleVBvbGljeSA9IHByb3BzLmN1c3RvbUtleVBvbGljeSA/IHByb3BzLmN1c3RvbUtleVBvbGljeS50b0pTT04oKSA6IGNyZWF0ZURlZmF1bHRSZXBsaWNhS2V5UG9saWN5KHRoaXMpO1xuXG4gICAgICBjb25zdCByZXBsaWNhS2V5ID0gbmV3IGttcy5DZm5SZXBsaWNhS2V5KHRoaXMsIFwiUmVwbGljYUtleVwiLCB7XG4gICAgICAgIHByaW1hcnlLZXlBcm4sXG4gICAgICAgIGtleVBvbGljeSxcbiAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMua2V5ID0ga21zLktleS5mcm9tS2V5QXJuKHRoaXMsIFwiSW1wb3J0ZWRSZXBsaWNhS2V5XCIsIHJlcGxpY2FLZXkuYXR0ckFybik7XG4gICAgICB0aGlzLmtleUFybiA9IHJlcGxpY2FLZXkuYXR0ckFybjtcbiAgICAgIHRoaXMua2V5SWQgPSByZXBsaWNhS2V5LmF0dHJLZXlJZDtcbiAgICAgIHRhZ1RhcmdldCA9IHJlcGxpY2FLZXk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGtleSA9IG5ldyBrbXMuS2V5KHRoaXMsIFwiS2V5XCIsIHtcbiAgICAgICAgZGVzY3JpcHRpb246IHByb3BzLmRlc2NyaXB0aW9uLFxuICAgICAgICBrZXlTcGVjLFxuICAgICAgICBrZXlVc2FnZSxcbiAgICAgICAgZW5hYmxlS2V5Um90YXRpb24sXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBlbmRpbmdXaW5kb3csXG4gICAgICAgIG11bHRpUmVnaW9uLFxuICAgICAgICBwb2xpY3k6IHByb3BzLmN1c3RvbUtleVBvbGljeSxcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLmtleSA9IGtleTtcbiAgICAgIHRoaXMua2V5QXJuID0ga2V5LmtleUFybjtcbiAgICAgIHRoaXMua2V5SWQgPSBrZXkua2V5SWQ7XG4gICAgICB0YWdUYXJnZXQgPSBrZXk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmFsaWFzTmFtZSkge1xuICAgICAgdGhpcy5hbGlhcyA9IG5ldyBrbXMuQWxpYXModGhpcywgXCJBbGlhc1wiLCB7XG4gICAgICAgIGFsaWFzTmFtZTogcHJvcHMuYWxpYXNOYW1lLFxuICAgICAgICB0YXJnZXRLZXk6IHRoaXMua2V5LFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmdyYW50RW5jcnlwdERlY3J5cHQpIHtcbiAgICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudEVuY3J5cHREZWNyeXB0KSB7XG4gICAgICAgIHRoaXMua2V5LmdyYW50RW5jcnlwdERlY3J5cHQoZ3JhbnRlZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmdyYW50R2VuZXJhdGVNYWMpIHtcbiAgICAgIGZvciAoY29uc3QgZ3JhbnRlZSBvZiBwcm9wcy5ncmFudEdlbmVyYXRlTWFjKSB7XG4gICAgICAgIHRoaXMua2V5LmdyYW50KGdyYW50ZWUsIFwia21zOkdlbmVyYXRlTWFjXCIsIFwia21zOlZlcmlmeU1hY1wiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZW5hYmxlU3NtUGFyYW1ldGVyICYmIHByb3BzLnNzbVBhcmFtZXRlclBhdGgpIHtcbiAgICAgIHRoaXMuc3NtUGFyYW1ldGVyID0gbmV3IHNzbS5TdHJpbmdQYXJhbWV0ZXIodGhpcywgXCJTU01QYXJhbWV0ZXJcIiwge1xuICAgICAgICBwYXJhbWV0ZXJOYW1lOiBwcm9wcy5zc21QYXJhbWV0ZXJQYXRoLFxuICAgICAgICBzdHJpbmdWYWx1ZTogdGhpcy5rZXlBcm4sXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgS01TIEtleSBBUk4gZm9yICR7cHJvcHMuZGVzY3JpcHRpb24gPz8gaWR9YCxcbiAgICAgICAgdGllcjogc3NtLlBhcmFtZXRlclRpZXIuU1RBTkRBUkQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGFnVGFyZ2V0KSB7XG4gICAgICBUYWdzLm9mKHRhZ1RhcmdldCkuYWRkKFwiRnJhbWV3b3JrXCIsIFwiQXBwVGhlb3J5XCIpO1xuICAgICAgVGFncy5vZih0YWdUYXJnZXQpLmFkZChcIkNvbXBvbmVudFwiLCBcIktNU1wiKTtcblxuICAgICAgaWYgKHByb3BzLnRhZ3MpIHtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocHJvcHMudGFncykpIHtcbiAgICAgICAgICBUYWdzLm9mKHRhZ1RhcmdldCkuYWRkKGtleSwgdmFsdWUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZURlZmF1bHRSZXBsaWNhS2V5UG9saWN5KHNjb3BlOiBDb25zdHJ1Y3QpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBhY2NvdW50SWQgPSBzdGFjay5hY2NvdW50O1xuICBjb25zdCByZWdpb24gPSBzdGFjay5yZWdpb247XG5cbiAgcmV0dXJuIHtcbiAgICBWZXJzaW9uOiBcIjIwMTItMTAtMTdcIixcbiAgICBTdGF0ZW1lbnQ6IFtcbiAgICAgIHtcbiAgICAgICAgU2lkOiBcIkVuYWJsZSBJQU0gVXNlciBQZXJtaXNzaW9uc1wiLFxuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgUHJpbmNpcGFsOiB7XG4gICAgICAgICAgQVdTOiBgYXJuOmF3czppYW06OiR7YWNjb3VudElkfTpyb290YCxcbiAgICAgICAgfSxcbiAgICAgICAgQWN0aW9uOiBcImttczoqXCIsXG4gICAgICAgIFJlc291cmNlOiBcIipcIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIFNpZDogXCJBbGxvdyB1c2Ugb2YgdGhlIGtleVwiLFxuICAgICAgICBFZmZlY3Q6IFwiQWxsb3dcIixcbiAgICAgICAgUHJpbmNpcGFsOiB7XG4gICAgICAgICAgQVdTOiBgYXJuOmF3czppYW06OiR7YWNjb3VudElkfTpyb290YCxcbiAgICAgICAgfSxcbiAgICAgICAgQWN0aW9uOiBbXG4gICAgICAgICAgXCJrbXM6RW5jcnlwdFwiLFxuICAgICAgICAgIFwia21zOkRlY3J5cHRcIixcbiAgICAgICAgICBcImttczpSZUVuY3J5cHQqXCIsXG4gICAgICAgICAgXCJrbXM6R2VuZXJhdGVEYXRhS2V5KlwiLFxuICAgICAgICAgIFwia21zOkNyZWF0ZUdyYW50XCIsXG4gICAgICAgICAgXCJrbXM6RGVzY3JpYmVLZXlcIixcbiAgICAgICAgICBcImttczpHZW5lcmF0ZU1hY1wiLFxuICAgICAgICAgIFwia21zOlZlcmlmeU1hY1wiLFxuICAgICAgICBdLFxuICAgICAgICBSZXNvdXJjZTogXCIqXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBTaWQ6IFwiQWxsb3cgQ2xvdWRXYXRjaCBMb2dzXCIsXG4gICAgICAgIEVmZmVjdDogXCJBbGxvd1wiLFxuICAgICAgICBQcmluY2lwYWw6IHtcbiAgICAgICAgICBTZXJ2aWNlOiBgbG9ncy4ke3JlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgIH0sXG4gICAgICAgIEFjdGlvbjogW1xuICAgICAgICAgIFwia21zOkVuY3J5cHRcIixcbiAgICAgICAgICBcImttczpEZWNyeXB0XCIsXG4gICAgICAgICAgXCJrbXM6UmVFbmNyeXB0KlwiLFxuICAgICAgICAgIFwia21zOkdlbmVyYXRlRGF0YUtleSpcIixcbiAgICAgICAgICBcImttczpDcmVhdGVHcmFudFwiLFxuICAgICAgICAgIFwia21zOkRlc2NyaWJlS2V5XCIsXG4gICAgICAgIF0sXG4gICAgICAgIFJlc291cmNlOiBcIipcIixcbiAgICAgIH0sXG4gICAgXSxcbiAgfTtcbn1cbiJdfQ==