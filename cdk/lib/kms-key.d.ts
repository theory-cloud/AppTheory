import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
export interface AppTheoryKmsKeyProps {
    readonly description?: string;
    readonly aliasName?: string;
    readonly primaryKeyArn?: string;
    readonly administratorArn?: string;
    readonly customKeyPolicy?: iam.PolicyDocument;
    readonly ssmParameterPath?: string;
    readonly tags?: Record<string, string>;
    readonly enabledRegions?: string[];
    readonly multiRegion?: boolean;
    readonly isReplicaKey?: boolean;
    readonly enableKeyRotation?: boolean;
    readonly enableSsmParameter?: boolean;
    readonly grantEncryptDecrypt?: iam.IGrantable[];
    readonly grantGenerateMac?: iam.IGrantable[];
    readonly keySpec?: kms.KeySpec;
    readonly keyUsage?: kms.KeyUsage;
    readonly pendingWindow?: Duration;
    readonly removalPolicy?: RemovalPolicy;
}
export declare class AppTheoryKmsKey extends Construct {
    readonly key: kms.IKey;
    readonly alias?: kms.Alias;
    readonly ssmParameter?: ssm.StringParameter;
    readonly keyArn: string;
    readonly keyId: string;
    constructor(scope: Construct, id: string, props?: AppTheoryKmsKeyProps);
}
