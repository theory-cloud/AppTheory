import { Duration, RemovalPolicy, Stack, Tags } from "aws-cdk-lib";
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

export class AppTheoryKmsKey extends Construct {
  public readonly key: kms.IKey;
  public readonly alias?: kms.Alias;
  public readonly ssmParameter?: ssm.StringParameter;
  public readonly keyArn: string;
  public readonly keyId: string;

  constructor(scope: Construct, id: string, props: AppTheoryKmsKeyProps = {}) {
    super(scope, id);

    const keySpec = props.keySpec ?? kms.KeySpec.SYMMETRIC_DEFAULT;
    const keyUsage =
      props.keyUsage ??
      (keySpec === kms.KeySpec.HMAC_256 ? kms.KeyUsage.GENERATE_VERIFY_MAC : kms.KeyUsage.ENCRYPT_DECRYPT);
    const enableKeyRotation =
      props.enableKeyRotation ?? (keySpec === kms.KeySpec.SYMMETRIC_DEFAULT ? true : false);
    const pendingWindow = props.pendingWindow ?? Duration.days(30);
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const multiRegion = props.multiRegion ?? false;
    const isReplicaKey = props.isReplicaKey ?? false;
    const enableSsmParameter = props.enableSsmParameter ?? false;

    let tagTarget: Construct | undefined;

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
    } else {
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
      Tags.of(tagTarget).add("Framework", "AppTheory");
      Tags.of(tagTarget).add("Component", "KMS");

      if (props.tags) {
        for (const [key, value] of Object.entries(props.tags)) {
          Tags.of(tagTarget).add(key, value);
        }
      }
    }
  }
}

function createDefaultReplicaKeyPolicy(scope: Construct): Record<string, unknown> {
  const stack = Stack.of(scope);
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
