import { ArnFormat, Names, Stack, Token } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * Properties for AppTheoryCloudWatchLogsDestination.
 */
export interface AppTheoryCloudWatchLogsDestinationProps {
  /**
   * Kinesis Data Stream that receives CloudWatch Logs subscription records.
   */
  readonly stream: kinesis.IStream;

  /**
   * Optional physical CloudWatch Logs destination name.
   *
   * @default - deterministic name derived from the construct path
   */
  readonly destinationName?: string;

  /**
   * Explicit AWS account IDs allowed to create subscription filters against this destination.
   *
   * At least one allowed source account or organization ID is required. AppTheory does not
   * synthesize a broad default destination policy.
   *
   * @default []
   */
  readonly allowedSourceAccounts?: string[];

  /**
   * Explicit AWS Organizations IDs allowed to create subscription filters against this destination.
   *
   * Organization entries use a wildcard principal only with an `aws:PrincipalOrgID` condition.
   * At least one allowed source account or organization ID is required.
   *
   * @default []
   */
  readonly allowedOrganizationIds?: string[];
}

/**
 * CloudWatch Logs destination that delivers subscription records to Kinesis.
 *
 * The construct owns the destination, the CloudWatch Logs service role, and a fail-closed
 * destination policy. Subscription filter writers must be explicitly allowed by source account
 * and/or AWS Organization ID; no unconstrained wildcard principal is synthesized.
 */
export class AppTheoryCloudWatchLogsDestination extends Construct {
  /**
   * The CloudWatch Logs destination resource.
   */
  public readonly destination: logs.CfnDestination;

  /**
   * IAM role assumed by CloudWatch Logs to write records to the target stream.
   */
  public readonly serviceRole: iam.Role;

  /**
   * The destination ARN.
   */
  public readonly destinationArn: string;

  /**
   * The destination name.
   */
  public readonly destinationName: string;

  constructor(scope: Construct, id: string, props: AppTheoryCloudWatchLogsDestinationProps) {
    super(scope, id);

    const allowedSourceAccounts = normalizeUniqueList(
      props.allowedSourceAccounts ?? [],
      "allowedSourceAccounts",
      validateAccountId,
    );
    const allowedOrganizationIds = normalizeUniqueList(
      props.allowedOrganizationIds ?? [],
      "allowedOrganizationIds",
      validateOrganizationId,
    );

    if (allowedSourceAccounts.length === 0 && allowedOrganizationIds.length === 0) {
      throw new Error(
        "AppTheoryCloudWatchLogsDestination requires allowedSourceAccounts and/or allowedOrganizationIds",
      );
    }

    this.destinationName = destinationName(this, props.destinationName);
    this.destinationArn = Stack.of(this).formatArn({
      service: "logs",
      resource: "destination",
      resourceName: this.destinationName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    this.serviceRole = new iam.Role(this, "ServiceRole", {
      assumedBy: servicePrincipalWithConditions(sourceArnTrustConditions(this, allowedSourceAccounts)),
    });

    if (allowedOrganizationIds.length > 0) {
      this.serviceRole.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          principals: [servicePrincipalWithConditions(sourceOrgTrustConditions(allowedOrganizationIds))],
        }),
      );
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

type Validator = (value: string, propName: string) => void;

type PolicyStatement = {
  Sid: string;
  Effect: "Allow";
  Principal: "*" | { AWS: string[] };
  Action: "logs:PutSubscriptionFilter";
  Resource: string;
  Condition?: {
    StringEquals: {
      "aws:PrincipalOrgID": string[];
    };
  };
};

function destinationName(scope: Construct, name?: string): string {
  const normalized =
    name === undefined ? Names.uniqueResourceName(scope, { maxLength: 512, separator: "-" }) : name.trim();

  if (!normalized) {
    throw new Error("AppTheoryCloudWatchLogsDestination: destinationName cannot be empty");
  }

  if (Token.isUnresolved(normalized)) {
    return normalized;
  }

  if (!/^[^:*]{1,512}$/.test(normalized)) {
    throw new Error(
      "AppTheoryCloudWatchLogsDestination: destinationName must be 1-512 characters and cannot contain ':' or '*'",
    );
  }

  return normalized;
}

function normalizeUniqueList(values: string[], propName: string, validate: Validator): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

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

function validateAccountId(accountId: string, propName: string): void {
  if (!accountId) {
    throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} cannot contain empty values`);
  }

  if (Token.isUnresolved(accountId)) {
    return;
  }

  if (!/^\d{12}$/.test(accountId)) {
    throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} must contain 12-digit AWS account IDs`);
  }
}

function validateOrganizationId(organizationId: string, propName: string): void {
  if (!organizationId) {
    throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} cannot contain empty values`);
  }

  if (Token.isUnresolved(organizationId)) {
    return;
  }

  if (!/^o-[a-z0-9]{10,32}$/.test(organizationId)) {
    throw new Error(`AppTheoryCloudWatchLogsDestination: ${propName} must contain AWS Organization IDs`);
  }
}

function servicePrincipalWithConditions(
  conditions: Record<string, Record<string, string | string[]>>,
): iam.ServicePrincipal {
  return new iam.ServicePrincipal("logs.amazonaws.com", { conditions });
}

function sourceArnTrustConditions(
  scope: Construct,
  allowedSourceAccounts: string[],
): Record<string, Record<string, string[]>> {
  const stack = Stack.of(scope);
  const accounts = [stack.account, ...allowedSourceAccounts];
  const seen = new Set<string>();
  const sourceArns: string[] = [];

  for (const account of accounts) {
    if (seen.has(account)) {
      continue;
    }
    seen.add(account);
    sourceArns.push(
      stack.formatArn({
        service: "logs",
        account,
        resource: "*",
      }),
    );
  }

  return {
    StringLike: {
      "aws:SourceArn": sourceArns,
    },
  };
}

function sourceOrgTrustConditions(
  allowedOrganizationIds: string[],
): Record<string, Record<string, string[]>> {
  return {
    StringEquals: {
      "aws:SourceOrgID": allowedOrganizationIds,
    },
  };
}

function destinationPolicy(
  destinationArn: string,
  allowedSourceAccounts: string[],
  allowedOrganizationIds: string[],
): string {
  const statements: PolicyStatement[] = [];

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
