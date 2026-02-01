import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
export interface AppTheoryDynamoTableGsiProps {
    readonly indexName: string;
    readonly partitionKeyName: string;
    readonly partitionKeyType?: dynamodb.AttributeType;
    readonly sortKeyName?: string;
    readonly sortKeyType?: dynamodb.AttributeType;
    readonly projectionType?: dynamodb.ProjectionType;
    readonly nonKeyAttributes?: string[];
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
}
export interface AppTheoryDynamoTableProps {
    readonly tableName: string;
    readonly partitionKeyName: string;
    readonly partitionKeyType?: dynamodb.AttributeType;
    readonly sortKeyName: string;
    readonly sortKeyType?: dynamodb.AttributeType;
    readonly timeToLiveAttribute?: string;
    readonly billingMode?: dynamodb.BillingMode;
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
    readonly removalPolicy?: RemovalPolicy;
    readonly deletionProtection?: boolean;
    readonly enablePointInTimeRecovery?: boolean;
    readonly encryption?: dynamodb.TableEncryption;
    readonly encryptionKey?: kms.IKey;
    readonly enableStream?: boolean;
    readonly streamViewType?: dynamodb.StreamViewType;
    readonly globalSecondaryIndexes?: AppTheoryDynamoTableGsiProps[];
    readonly grantReadTo?: iam.IGrantable[];
    readonly grantWriteTo?: iam.IGrantable[];
    readonly grantReadWriteTo?: iam.IGrantable[];
    readonly grantStreamReadTo?: iam.IGrantable[];
}
export declare class AppTheoryDynamoTable extends Construct {
    readonly table: dynamodb.Table;
    constructor(scope: Construct, id: string, props: AppTheoryDynamoTableProps);
}
