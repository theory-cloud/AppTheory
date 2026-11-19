import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { AppTheoryCloudFrontLogFormat } from "../logging";
import type { AppTheoryNamingContext } from "../naming-context";

/**
 * The CloudFront standard-logging record fields, in delivery order
 * (contract section 3).
 */
export const CLOUD_FRONT_RECORD_FIELDS = [
  "timestamp",
  "x-edge-request-id",
  "cs-method",
  "cs-uri-stem",
  "sc-status",
  "sc-bytes",
  "time-taken",
  "x-edge-result-type",
  "c-ip",
];

/**
 * The API Gateway access-log field names and values for HTTP APIs.
 */
export function httpApiAccessLogFormat(): string {
  return JSON.stringify({
    requestId: "$context.requestId",
    requestTime: "$context.requestTime",
    httpMethod: "$context.httpMethod",
    routeKey: "$context.routeKey",
    status: "$context.status",
    protocol: "$context.protocol",
    responseLength: "$context.responseLength",
    integrationLatency: "$context.integrationLatency",
    sourceIp: "$context.identity.sourceIp",
  });
}

/**
 * The API Gateway access-log field names and values for REST APIs.
 */
export function restApiAccessLogFormat(): apigw.AccessLogFormat {
  return apigw.AccessLogFormat.custom(
    JSON.stringify({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      resourcePath: "$context.resourcePath",
      status: "$context.status",
      protocol: "$context.protocol",
      responseLength: "$context.responseLength",
      responseLatency: "$context.responseLatency",
      sourceIp: "$context.identity.sourceIp",
    }),
  );
}

/**
 * Resolve the numeric retention to the CloudWatch Logs enum. The context has
 * already validated the value against the accepted set.
 */
export function retentionFor(days: number): logs.RetentionDays {
  return days as logs.RetentionDays;
}

/**
 * Create a standard-profile log group named from the naming contract.
 */
export function standardLogGroup(
  scope: Construct,
  id: string,
  context: AppTheoryNamingContext,
  logical: string,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: context.logGroupName(logical),
    retention: retentionFor(context.retentionDays),
  });
}

/**
 * Wire CloudFront standard logging through CloudWatch Logs vended delivery:
 * a delivery source, a delivery destination over the log group, and a delivery
 * carrying the contract's record fields.
 *
 * The contract requires these resources in `us-east-1`; a stack elsewhere is
 * out of v0.1, so synthesis fails instead of creating a delivery that cannot
 * receive CloudFront logs.
 */
export function enableCloudFrontStandardLogging(options: {
  readonly scope: Construct;
  readonly id: string;
  readonly context: AppTheoryNamingContext;
  readonly distribution: cloudfront.IDistribution;
  readonly logical: string;
  readonly format?: AppTheoryCloudFrontLogFormat;
}): logs.LogGroup {
  const { scope, id, context, distribution, logical } = options;
  if (context.region !== "us-east-1") {
    throw new Error(
      `CloudFront standard logging requires a us-east-1 stack (got ${context.region}); a stack outside us-east-1 is out of the v0.1 resource-naming contract`,
    );
  }
  const logGroup = standardLogGroup(scope, `${id}LogGroup`, context, logical);

  const source = new logs.CfnDeliverySource(scope, `${id}DeliverySource`, {
    name: context.physicalName("log_delivery_source", logical).name,
    logType: "ACCESS_LOGS",
    resourceArn: distribution.distributionArn,
  });

  const destination = new logs.CfnDeliveryDestination(scope, `${id}DeliveryDestination`, {
    name: context.physicalName("log_delivery_destination", logical).name,
    destinationResourceArn: logGroup.logGroupArn,
    outputFormat: options.format ?? AppTheoryCloudFrontLogFormat.W3C,
  });

  new logs.CfnDelivery(scope, `${id}Delivery`, {
    deliverySourceName: source.name,
    deliveryDestinationArn: destination.attrArn,
    recordFields: [...CLOUD_FRONT_RECORD_FIELDS],
  });

  return logGroup;
}

/**
 * The bucket-name properties the naming contract requires. A derived profile
 * sets the account-regional namespace and prefix; a legacy profile supplies the
 * pinned full name.
 */
export function bucketNamingProps(
  context: AppTheoryNamingContext,
  logical: string,
  explicitName?: string,
): { bucketName?: string; bucketNamespace?: s3.BucketNamespace; bucketNamePrefix?: string } {
  const composed = context.physicalName("s3_bucket", logical);
  if (composed.pinned) {
    if (explicitName !== undefined && explicitName !== composed.name) {
      throw new Error(
        `AppTheory bucket ${logical} cannot honor ${JSON.stringify(explicitName)} when the legacy pin is ${JSON.stringify(composed.name)}`,
      );
    }
    return { bucketName: composed.name };
  }
  if (explicitName !== undefined) {
    throw new Error(
      `AppTheory derives the bucket name for ${logical} from the naming context; omit the explicit name or use the legacy profile with a pin`,
    );
  }
  if (composed.bucketNamePrefix === undefined) {
    throw new Error(`AppTheory bucket ${logical} requires an account-regional prefix`);
  }
  return {
    bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
    bucketNamePrefix: composed.bucketNamePrefix,
  };
}
