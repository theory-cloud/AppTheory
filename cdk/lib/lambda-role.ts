import { Tags } from "aws-cdk-lib";
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
export class AppTheoryLambdaRole extends Construct {
    /**
     * The underlying IAM Role.
     */
    public readonly role: iam.Role;

    /**
     * The ARN of the IAM Role.
     */
    public readonly roleArn: string;

    /**
     * The name of the IAM Role.
     */
    public readonly roleName: string;

    constructor(scope: Construct, id: string, props: AppTheoryLambdaRoleProps = {}) {
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
            this.role.addToPolicy(
                new iam.PolicyStatement({
                    sid: "AllowEnvironmentDecryption",
                    actions: ["kms:Decrypt"],
                    resources: envKeyArns,
                }),
            );
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
        Tags.of(this.role).add("Framework", "AppTheory");
        Tags.of(this.role).add("Component", "LambdaRole");

        if (props.tags) {
            for (const [key, value] of Object.entries(props.tags)) {
                Tags.of(this.role).add(key, value);
            }
        }
    }

    /**
     * Grant this role to a grantable principal.
     * This is useful when you need to allow another entity to assume this role.
     */
    public grantAssumeRole(grantee: iam.IPrincipal): iam.Grant {
        return this.role.grantAssumeRole(grantee);
    }

    /**
     * Grant permissions to pass this role.
     * This is required when a service needs to pass this role to Lambda.
     */
    public grantPassRole(grantee: iam.IPrincipal): iam.Grant {
        return this.role.grantPassRole(grantee);
    }

    /**
     * Add a managed policy to this role.
     */
    public addManagedPolicy(policy: iam.IManagedPolicy): void {
        this.role.addManagedPolicy(policy);
    }

    /**
     * Add an inline policy statement to this role.
     */
    public addToPolicy(statement: iam.PolicyStatement): boolean {
        return this.role.addToPolicy(statement);
    }
}
