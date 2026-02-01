import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
/**
 * Properties for AppTheoryLambdaRole.
 */
export interface AppTheoryLambdaRoleProps {
    /**
     * Optional role name. If not provided, CloudFormation will generate a unique name.
     */
    readonly roleName?: string;
    /**
     * Optional description for the IAM role.
     */
    readonly description?: string;
    /**
     * Enable X-Ray tracing permissions by attaching AWSXRayDaemonWriteAccess managed policy.
     * @default false
     */
    readonly enableXRay?: boolean;
    /**
     * KMS key(s) for Lambda environment variable encryption.
     * Grants the role permission to decrypt environment variables encrypted with these keys.
     */
    readonly environmentEncryptionKeys?: kms.IKey[];
    /**
     * KMS key(s) for application-level KMS usage (encrypt/decrypt data at runtime).
     * Grants the role full encrypt/decrypt permissions on these keys.
     */
    readonly applicationKmsKeys?: kms.IKey[];
    /**
     * Additional inline policy statements to attach to the role.
     * Use this escape hatch for any additional permissions not covered by the construct.
     */
    readonly additionalStatements?: iam.PolicyStatement[];
    /**
     * Tags to apply to the IAM role.
     */
    readonly tags?: Record<string, string>;
}
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
export declare class AppTheoryLambdaRole extends Construct {
    /**
     * The underlying IAM Role.
     */
    readonly role: iam.Role;
    /**
     * The ARN of the IAM Role.
     */
    readonly roleArn: string;
    /**
     * The name of the IAM Role.
     */
    readonly roleName: string;
    constructor(scope: Construct, id: string, props?: AppTheoryLambdaRoleProps);
    /**
     * Grant this role to a grantable principal.
     * This is useful when you need to allow another entity to assume this role.
     */
    grantAssumeRole(grantee: iam.IPrincipal): iam.Grant;
    /**
     * Grant permissions to pass this role.
     * This is required when a service needs to pass this role to Lambda.
     */
    grantPassRole(grantee: iam.IPrincipal): iam.Grant;
    /**
     * Add a managed policy to this role.
     */
    addManagedPolicy(policy: iam.IManagedPolicy): void;
    /**
     * Add an inline policy statement to this role.
     */
    addToPolicy(statement: iam.PolicyStatement): boolean;
}
