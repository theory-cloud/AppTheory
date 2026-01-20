import type { Duration } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

export interface AppTheoryDynamoDBStreamMappingProps {
  readonly consumer: lambda.Function;
  readonly table: dynamodb.ITable;
  readonly startingPosition?: lambda.StartingPosition;
  readonly batchSize?: number;
  readonly bisectBatchOnError?: boolean;
  readonly retryAttempts?: number;
  readonly maxRecordAge?: Duration;
  readonly reportBatchItemFailures?: boolean;
}

export class AppTheoryDynamoDBStreamMapping extends Construct {
  constructor(scope: Construct, id: string, props: AppTheoryDynamoDBStreamMappingProps) {
    super(scope, id);

    props.consumer.addEventSource(
      new lambdaEventSources.DynamoEventSource(props.table, {
        startingPosition: props.startingPosition ?? lambda.StartingPosition.LATEST,
        batchSize: props.batchSize,
        bisectBatchOnError: props.bisectBatchOnError,
        retryAttempts: props.retryAttempts,
        maxRecordAge: props.maxRecordAge,
        reportBatchItemFailures: props.reportBatchItemFailures ?? true,
      }),
    );

    props.table.grantStreamRead(props.consumer);
  }
}

