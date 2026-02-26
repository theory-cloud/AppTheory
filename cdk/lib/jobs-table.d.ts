import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryJobsTableProps {
    /**
     * Optional table name.
     * @default - CloudFormation-generated name
     */
    readonly tableName?: string;
    /**
     * Billing mode for the table.
     * @default PAY_PER_REQUEST
     */
    readonly billingMode?: dynamodb.BillingMode;
    /**
     * Removal policy for the table.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;
    /**
     * Whether deletion protection should be enabled for the table.
     * @default - AWS default (no deletion protection)
     */
    readonly deletionProtection?: boolean;
    /**
     * TTL attribute name.
     * @default "ttl"
     */
    readonly timeToLiveAttribute?: string;
    /**
     * Whether point-in-time recovery should be enabled.
     * @default true
     */
    readonly enablePointInTimeRecovery?: boolean;
    /**
     * Table encryption setting.
     * @default AWS_MANAGED
     */
    readonly encryption?: dynamodb.TableEncryption;
    /**
     * Customer-managed KMS key (required when encryption is CUSTOMER_MANAGED).
     */
    readonly encryptionKey?: kms.IKey;
    /**
     * Provisioned read capacity (only used when billingMode is PROVISIONED).
     * @default 5
     */
    readonly readCapacity?: number;
    /**
     * Provisioned write capacity (only used when billingMode is PROVISIONED).
     * @default 5
     */
    readonly writeCapacity?: number;
    /**
     * Principals to grant DynamoDB read permissions to.
     */
    readonly grantReadTo?: iam.IGrantable[];
    /**
     * Principals to grant DynamoDB write permissions to.
     */
    readonly grantWriteTo?: iam.IGrantable[];
    /**
     * Principals to grant DynamoDB read/write permissions to.
     */
    readonly grantReadWriteTo?: iam.IGrantable[];
}
/**
 * Opinionated DynamoDB table for import pipeline job ledgers.
 *
 * Canonical schema:
 * - PK: `pk` (string)
 * - SK: `sk` (string)
 *
 * Canonical GSIs (locked by ADR 0002):
 * - `status-created-index`: `status` (pk) + `created_at` (sk)
 * - `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)
 *
 * Canonical TTL attribute:
 * - `ttl` (configurable)
 */
export declare class AppTheoryJobsTable extends Construct {
    readonly table: dynamodb.Table;
    constructor(scope: Construct, id: string, props?: AppTheoryJobsTableProps);
    /**
     * Binds the canonical jobs table env var to a Lambda function.
     */
    bindEnvironment(fn: lambda.Function): void;
    /**
     * Grant DynamoDB read permissions.
     */
    grantReadTo(grantee: iam.IGrantable): void;
    /**
     * Grant DynamoDB write permissions.
     */
    grantWriteTo(grantee: iam.IGrantable): void;
    /**
     * Grant DynamoDB read/write permissions.
     */
    grantReadWriteTo(grantee: iam.IGrantable): void;
}
