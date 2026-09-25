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
exports.AppTheoryLambdaRole = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const constructs_1 = require("constructs");
/**
 * A Lambda execution role construct with baseline permissions and optional enhancements.
 *
 * Creates an IAM role suitable for Lambda execution with:
 * - Basic Lambda execution permissions (CloudWatch Logs)
 * - Optional X-Ray tracing permissions
 * - Optional KMS permissions for environment encryption
 * - Optional KMS permissions for application-level encryption
 * - Escape hatch for additional inline policy statements
 *
 * @example
 * const role = new AppTheoryLambdaRole(this, 'LambdaRole', {
 *   roleName: 'my-lambda-role',
 *   enableXRay: true,
 *   environmentEncryptionKeys: [envKey],
 *   applicationKmsKeys: [dataKey],
 *   additionalStatements: [
 *     new iam.PolicyStatement({
 *       actions: ['s3:GetObject'],
 *       resources: ['arn:aws:s3:::my-bucket/*'],
 *     }),
 *   ],
 * });
 */
class AppTheoryLambdaRole extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryLambdaRole", version: "4.4.2" };
    /**
     * The underlying IAM Role.
     */
    role;
    /**
     * The ARN of the IAM Role.
     */
    roleArn;
    /**
     * The name of the IAM Role.
     */
    roleName;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const enableXRay = props.enableXRay ?? false;
        // Create the base Lambda execution role
        this.role = new iam.Role(this, "Role", {
            roleName: props.roleName,
            description: props.description ?? "Lambda execution role created by AppTheory",
            assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        });
        // Attach baseline Lambda execution managed policy (CloudWatch Logs permissions)
        this.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));
        // Optional: X-Ray tracing permissions
        if (enableXRay) {
            this.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"));
        }
        // Optional: KMS permissions for environment variable encryption
        if (props.environmentEncryptionKeys && props.environmentEncryptionKeys.length > 0) {
            const envKeyArns = props.environmentEncryptionKeys.map((key) => key.keyArn);
            this.role.addToPolicy(new iam.PolicyStatement({
                sid: "AllowEnvironmentDecryption",
                actions: ["kms:Decrypt"],
                resources: envKeyArns,
            }));
        }
        // Optional: KMS permissions for application-level encrypt/decrypt
        if (props.applicationKmsKeys && props.applicationKmsKeys.length > 0) {
            for (const key of props.applicationKmsKeys) {
                key.grantEncryptDecrypt(this.role);
            }
        }
        // Optional: Additional inline policy statements (escape hatch)
        if (props.additionalStatements && props.additionalStatements.length > 0) {
            for (const statement of props.additionalStatements) {
                this.role.addToPolicy(statement);
            }
        }
        // Expose role properties
        this.roleArn = this.role.roleArn;
        this.roleName = this.role.roleName;
        // Apply tags
        aws_cdk_lib_1.Tags.of(this.role).add("Framework", "AppTheory");
        aws_cdk_lib_1.Tags.of(this.role).add("Component", "LambdaRole");
        if (props.tags) {
            for (const [key, value] of Object.entries(props.tags)) {
                aws_cdk_lib_1.Tags.of(this.role).add(key, value);
            }
        }
    }
    /**
     * Grant this role to a grantable principal.
     * This is useful when you need to allow another entity to assume this role.
     */
    grantAssumeRole(grantee) {
        return this.role.grantAssumeRole(grantee);
    }
    /**
     * Grant permissions to pass this role.
     * This is required when a service needs to pass this role to Lambda.
     */
    grantPassRole(grantee) {
        return this.role.grantPassRole(grantee);
    }
    /**
     * Add a managed policy to this role.
     */
    addManagedPolicy(policy) {
        this.role.addManagedPolicy(policy);
    }
    /**
     * Add an inline policy statement to this role.
     */
    addToPolicy(statement) {
        return this.role.addToPolicy(statement);
    }
}
exports.AppTheoryLambdaRole = AppTheoryLambdaRole;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFtYmRhLXJvbGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsYW1iZGEtcm9sZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW1DO0FBQ25DLHlEQUEyQztBQUUzQywyQ0FBdUM7QUE4Q3ZDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVCRztBQUNILE1BQWEsbUJBQW9CLFNBQVEsc0JBQVM7O0lBQzlDOztPQUVHO0lBQ2EsSUFBSSxDQUFXO0lBRS9COztPQUVHO0lBQ2EsT0FBTyxDQUFTO0lBRWhDOztPQUVHO0lBQ2EsUUFBUSxDQUFTO0lBRWpDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBa0MsRUFBRTtRQUMxRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxVQUFVLElBQUksS0FBSyxDQUFDO1FBRTdDLHdDQUF3QztRQUN4QyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFO1lBQ25DLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUTtZQUN4QixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsSUFBSSw0Q0FBNEM7WUFDOUUsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHNCQUFzQixDQUFDO1NBQzlELENBQUMsQ0FBQztRQUVILGdGQUFnRjtRQUNoRixJQUFJLENBQUMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsMENBQTBDLENBQUMsQ0FBQyxDQUFDO1FBRW5ILHNDQUFzQztRQUN0QyxJQUFJLFVBQVUsRUFBRSxDQUFDO1lBQ2IsSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLHdCQUF3QixDQUFD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a0RBMEdDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVGFncyB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBrbXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5TGFtYmRhUm9sZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlMYW1iZGFSb2xlUHJvcHMge1xuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHJvbGUgbmFtZS4gSWYgbm90IHByb3ZpZGVkLCBDbG91ZEZvcm1hdGlvbiB3aWxsIGdlbmVyYXRlIGEgdW5pcXVlIG5hbWUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcm9sZU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBkZXNjcmlwdGlvbiBmb3IgdGhlIElBTSByb2xlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIFgtUmF5IHRyYWNpbmcgcGVybWlzc2lvbnMgYnkgYXR0YWNoaW5nIEFXU1hSYXlEYWVtb25Xcml0ZUFjY2VzcyBtYW5hZ2VkIHBvbGljeS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZVhSYXk/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogS01TIGtleShzKSBmb3IgTGFtYmRhIGVudmlyb25tZW50IHZhcmlhYmxlIGVuY3J5cHRpb24uXG4gICAgICogR3JhbnRzIHRoZSByb2xlIHBlcm1pc3Npb24gdG8gZGVjcnlwdCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgZW5jcnlwdGVkIHdpdGggdGhlc2Uga2V5cy5cbiAgICAgKi9cbiAgICByZWFkb25seSBlbnZpcm9ubWVudEVuY3J5cHRpb25LZXlzPzoga21zLklLZXlbXTtcblxuICAgIC8qKlxuICAgICAqIEtNUyBrZXkocykgZm9yIGFwcGxpY2F0aW9uLWxldmVsIEtNUyB1c2FnZSAoZW5jcnlwdC9kZWNyeXB0IGRhdGEgYXQgcnVudGltZSkuXG4gICAgICogR3JhbnRzIHRoZSByb2xlIGZ1bGwgZW5jcnlwdC9kZWNyeXB0IHBlcm1pc3Npb25zIG9uIHRoZXNlIGtleXMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBwbGljYXRpb25LbXNLZXlzPzoga21zLklLZXlbXTtcblxuICAgIC8qKlxuICAgICAqIEFkZGl0aW9uYWwgaW5saW5lIHBvbGljeSBzdGF0ZW1lbnRzIHRvIGF0dGFjaCB0byB0aGUgcm9sZS5cbiAgICAgKiBVc2UgdGhpcyBlc2NhcGUgaGF0Y2ggZm9yIGFueSBhZGRpdGlvbmFsIHBlcm1pc3Npb25zIG5vdCBjb3ZlcmVkIGJ5IHRoZSBjb25zdHJ1Y3QuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWRkaXRpb25hbFN0YXRlbWVudHM/OiBpYW0uUG9saWN5U3RhdGVtZW50W107XG5cbiAgICAvKipcbiAgICAgKiBUYWdzIHRvIGFwcGx5IHRvIHRoZSBJQU0gcm9sZS5cbiAgICAgKi9cbiAgICByZWFkb25seSB0YWdzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuLyoqXG4gKiBBIExhbWJkYSBleGVjdXRpb24gcm9sZSBjb25zdHJ1Y3Qgd2l0aCBiYXNlbGluZSBwZXJtaXNzaW9ucyBhbmQgb3B0aW9uYWwgZW5oYW5jZW1lbnRzLlxuICpcbiAqIENyZWF0ZXMgYW4gSUFNIHJvbGUgc3VpdGFibGUgZm9yIExhbWJkYSBleGVjdXRpb24gd2l0aDpcbiAqIC0gQmFzaWMgTGFtYmRhIGV4ZWN1dGlvbiBwZXJtaXNzaW9ucyAoQ2xvdWRXYXRjaCBMb2dzKVxuICogLSBPcHRpb25hbCBYLVJheSB0cmFjaW5nIHBlcm1pc3Npb25zXG4gKiAtIE9wdGlvbmFsIEtNUyBwZXJtaXNzaW9ucyBmb3IgZW52aXJvbm1lbnQgZW5jcnlwdGlvblxuICogLSBPcHRpb25hbCBLTVMgcGVybWlzc2lvbnMgZm9yIGFwcGxpY2F0aW9uLWxldmVsIGVuY3J5cHRpb25cbiAqIC0gRXNjYXBlIGhhdGNoIGZvciBhZGRpdGlvbmFsIGlubGluZSBwb2xpY3kgc3RhdGVtZW50c1xuICpcbiAqIEBleGFtcGxlXG4gKiBjb25zdCByb2xlID0gbmV3IEFwcFRoZW9yeUxhbWJkYVJvbGUodGhpcywgJ0xhbWJkYVJvbGUnLCB7XG4gKiAgIHJvbGVOYW1lOiAnbXktbGFtYmRhLXJvbGUnLFxuICogICBlbmFibGVYUmF5OiB0cnVlLFxuICogICBlbnZpcm9ubWVudEVuY3J5cHRpb25LZXlzOiBbZW52S2V5XSxcbiAqICAgYXBwbGljYXRpb25LbXNLZXlzOiBbZGF0YUtleV0sXG4gKiAgIGFkZGl0aW9uYWxTdGF0ZW1lbnRzOiBbXG4gKiAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICogICAgICAgYWN0aW9uczogWydzMzpHZXRPYmplY3QnXSxcbiAqICAgICAgIHJlc291cmNlczogWydhcm46YXdzOnMzOjo6bXktYnVja2V0LyonXSxcbiAqICAgICB9KSxcbiAqICAgXSxcbiAqIH0pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TGFtYmRhUm9sZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIHVuZGVybHlpbmcgSUFNIFJvbGUuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHJvbGU6IGlhbS5Sb2xlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIEFSTiBvZiB0aGUgSUFNIFJvbGUuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHJvbGVBcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFRoZSBuYW1lIG9mIHRoZSBJQU0gUm9sZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcm9sZU5hbWU6IHN0cmluZztcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlMYW1iZGFSb2xlUHJvcHMgPSB7fSkge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIGNvbnN0IGVuYWJsZVhSYXkgPSBwcm9wcy5lbmFibGVYUmF5ID8/IGZhbHNlO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgYmFzZSBMYW1iZGEgZXhlY3V0aW9uIHJvbGVcbiAgICAgICAgdGhpcy5yb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiUm9sZVwiLCB7XG4gICAgICAgICAgICByb2xlTmFtZTogcHJvcHMucm9sZU5hbWUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogcHJvcHMuZGVzY3JpcHRpb24gPz8gXCJMYW1iZGEgZXhlY3V0aW9uIHJvbGUgY3JlYXRlZCBieSBBcHBUaGVvcnlcIixcbiAgICAgICAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEF0dGFjaCBiYXNlbGluZSBMYW1iZGEgZXhlY3V0aW9uIG1hbmFnZWQgcG9saWN5IChDbG91ZFdhdGNoIExvZ3MgcGVybWlzc2lvbnMpXG4gICAgICAgIHRoaXMucm9sZS5hZGRNYW5hZ2VkUG9saWN5KGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcInNlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIikpO1xuXG4gICAgICAgIC8vIE9wdGlvbmFsOiBYLVJheSB0cmFjaW5nIHBlcm1pc3Npb25zXG4gICAgICAgIGlmIChlbmFibGVYUmF5KSB7XG4gICAgICAgICAgICB0aGlzLnJvbGUuYWRkTWFuYWdlZFBvbGljeShpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBV1NYUmF5RGFlbW9uV3JpdGVBY2Nlc3NcIikpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT3B0aW9uYWw6IEtNUyBwZXJtaXNzaW9ucyBmb3IgZW52aXJvbm1lbnQgdmFyaWFibGUgZW5jcnlwdGlvblxuICAgICAgICBpZiAocHJvcHMuZW52aXJvbm1lbnRFbmNyeXB0aW9uS2V5cyAmJiBwcm9wcy5lbnZpcm9ubWVudEVuY3J5cHRpb25LZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IGVudktleUFybnMgPSBwcm9wcy5lbnZpcm9ubWVudEVuY3J5cHRpb25LZXlzLm1hcCgoa2V5KSA9PiBrZXkua2V5QXJuKTtcbiAgICAgICAgICAgIHRoaXMucm9sZS5hZGRUb1BvbGljeShcbiAgICAgICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgICAgICAgIHNpZDogXCJBbGxvd0Vudmlyb25tZW50RGVjcnlwdGlvblwiLFxuICAgICAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXCJrbXM6RGVjcnlwdFwiXSxcbiAgICAgICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBlbnZLZXlBcm5zLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIE9wdGlvbmFsOiBLTVMgcGVybWlzc2lvbnMgZm9yIGFwcGxpY2F0aW9uLWxldmVsIGVuY3J5cHQvZGVjcnlwdFxuICAgICAgICBpZiAocHJvcHMuYXBwbGljYXRpb25LbXNLZXlzICYmIHByb3BzLmFwcGxpY2F0aW9uS21zS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBwcm9wcy5hcHBsaWNhdGlvbkttc0tleXMpIHtcbiAgICAgICAgICAgICAgICBrZXkuZ3JhbnRFbmNyeXB0RGVjcnlwdCh0aGlzLnJvbGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gT3B0aW9uYWw6IEFkZGl0aW9uYWwgaW5saW5lIHBvbGljeSBzdGF0ZW1lbnRzIChlc2NhcGUgaGF0Y2gpXG4gICAgICAgIGlmIChwcm9wcy5hZGRpdGlvbmFsU3RhdGVtZW50cyAmJiBwcm9wcy5hZGRpdGlvbmFsU3RhdGVtZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHN0YXRlbWVudCBvZiBwcm9wcy5hZGRpdGlvbmFsU3RhdGVtZW50cykge1xuICAgICAgICAgICAgICAgIHRoaXMucm9sZS5hZGRUb1BvbGljeShzdGF0ZW1lbnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRXhwb3NlIHJvbGUgcHJvcGVydGllc1xuICAgICAgICB0aGlzLnJvbGVBcm4gPSB0aGlzLnJvbGUucm9sZUFybjtcbiAgICAgICAgdGhpcy5yb2xlTmFtZSA9IHRoaXMucm9sZS5yb2xlTmFtZTtcblxuICAgICAgICAvLyBBcHBseSB0YWdzXG4gICAgICAgIFRhZ3Mub2YodGhpcy5yb2xlKS5hZGQoXCJGcmFtZXdvcmtcIiwgXCJBcHBUaGVvcnlcIik7XG4gICAgICAgIFRhZ3Mub2YodGhpcy5yb2xlKS5hZGQoXCJDb21wb25lbnRcIiwgXCJMYW1iZGFSb2xlXCIpO1xuXG4gICAgICAgIGlmIChwcm9wcy50YWdzKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwcm9wcy50YWdzKSkge1xuICAgICAgICAgICAgICAgIFRhZ3Mub2YodGhpcy5yb2xlKS5hZGQoa2V5LCB2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHcmFudCB0aGlzIHJvbGUgdG8gYSBncmFudGFibGUgcHJpbmNpcGFsLlxuICAgICAqIFRoaXMgaXMgdXNlZnVsIHdoZW4geW91IG5lZWQgdG8gYWxsb3cgYW5vdGhlciBlbnRpdHkgdG8gYXNzdW1lIHRoaXMgcm9sZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgZ3JhbnRBc3N1bWVSb2xlKGdyYW50ZWU6IGlhbS5JUHJpbmNpcGFsKTogaWFtLkdyYW50IHtcbiAgICAgICAgcmV0dXJuIHRoaXMucm9sZS5ncmFudEFzc3VtZVJvbGUoZ3JhbnRlZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR3JhbnQgcGVybWlzc2lvbnMgdG8gcGFzcyB0aGlzIHJvbGUuXG4gICAgICogVGhpcyBpcyByZXF1aXJlZCB3aGVuIGEgc2VydmljZSBuZWVkcyB0byBwYXNzIHRoaXMgcm9sZSB0byBMYW1iZGEuXG4gICAgICovXG4gICAgcHVibGljIGdyYW50UGFzc1JvbGUoZ3JhbnRlZTogaWFtLklQcmluY2lwYWwpOiBpYW0uR3JhbnQge1xuICAgICAgICByZXR1cm4gdGhpcy5yb2xlLmdyYW50UGFzc1JvbGUoZ3JhbnRlZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgbWFuYWdlZCBwb2xpY3kgdG8gdGhpcyByb2xlLlxuICAgICAqL1xuICAgIHB1YmxpYyBhZGRNYW5hZ2VkUG9saWN5KHBvbGljeTogaWFtLklNYW5hZ2VkUG9saWN5KTogdm9pZCB7XG4gICAgICAgIHRoaXMucm9sZS5hZGRNYW5hZ2VkUG9saWN5KHBvbGljeSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGFuIGlubGluZSBwb2xpY3kgc3RhdGVtZW50IHRvIHRoaXMgcm9sZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgYWRkVG9Qb2xpY3koc3RhdGVtZW50OiBpYW0uUG9saWN5U3RhdGVtZW50KTogYm9vbGVhbiB7XG4gICAgICAgIHJldHVybiB0aGlzLnJvbGUuYWRkVG9Qb2xpY3koc3RhdGVtZW50KTtcbiAgICB9XG59XG4iXX0=