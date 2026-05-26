import { Token } from "aws-cdk-lib";
import type { Duration } from "aws-cdk-lib";
import type * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

/**
 * Properties for AppTheoryKinesisStreamMapping.
 */
export interface AppTheoryKinesisStreamMappingProps {
  /**
   * The Lambda function that will consume records from the stream.
   */
  readonly consumer: lambda.IFunction;

  /**
   * The Kinesis Data Stream to consume.
   */
  readonly stream: kinesis.IStream;

  /**
   * Where to begin consuming the stream.
   *
   * @default lambda.StartingPosition.LATEST
   */
  readonly startingPosition?: lambda.StartingPosition;

  /**
   * The Unix timestamp, in seconds, used with lambda.StartingPosition.AT_TIMESTAMP.
   *
   * @default - no timestamp
   */
  readonly startingPositionTimestamp?: number;

  /**
   * The largest number of records that AWS Lambda retrieves per invocation.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly batchSize?: number;

  /**
   * The maximum amount of time to gather records before invoking the function.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly maxBatchingWindow?: Duration;

  /**
   * Maximum number of retry attempts for failed records.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly retryAttempts?: number;

  /**
   * The maximum age of a record that Lambda sends to the consumer.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly maxRecordAge?: Duration;

  /**
   * Split a failed batch in two and retry.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly bisectBatchOnError?: boolean;

  /**
   * The number of batches to process from each shard concurrently.
   *
   * @default - AWS Lambda default for Kinesis event source mappings
   */
  readonly parallelizationFactor?: number;

  /**
   * Allow partial-batch failure responses from the consumer.
   *
   * AppTheory defaults this on so Kinesis consumers can fail closed per record
   * instead of replaying successfully processed records.
   *
   * @default true
   */
  readonly reportBatchItemFailures?: boolean;

  /**
   * The tumbling window used to group records before invocation.
   *
   * @default - no tumbling window
   */
  readonly tumblingWindow?: Duration;
}

/**
 * Wires a Kinesis Data Stream to a Lambda consumer.
 *
 * The mapping owns no stream lifecycle. Use AppTheoryKinesisStream when the
 * application should create or wrap the stream, then pass its `stream` here.
 */
export class AppTheoryKinesisStreamMapping extends Construct {
  constructor(scope: Construct, id: string, props: AppTheoryKinesisStreamMappingProps) {
    super(scope, id);

    const startingPosition = props.startingPosition ?? lambda.StartingPosition.LATEST;
    validateStartingPositionTimestamp(startingPosition, props.startingPositionTimestamp);

    props.consumer.addEventSource(
      new lambdaEventSources.KinesisEventSource(props.stream, {
        startingPosition,
        startingPositionTimestamp: props.startingPositionTimestamp,
        batchSize: props.batchSize,
        maxBatchingWindow: props.maxBatchingWindow,
        retryAttempts: props.retryAttempts,
        maxRecordAge: props.maxRecordAge,
        bisectBatchOnError: props.bisectBatchOnError,
        parallelizationFactor: props.parallelizationFactor,
        reportBatchItemFailures: props.reportBatchItemFailures ?? true,
        tumblingWindow: props.tumblingWindow,
      }),
    );

    props.stream.grantRead(props.consumer);
  }
}

function validateStartingPositionTimestamp(
  startingPosition: lambda.StartingPosition,
  startingPositionTimestamp?: number,
): void {
  if (startingPosition === lambda.StartingPosition.AT_TIMESTAMP && startingPositionTimestamp === undefined) {
    throw new Error(
      "AppTheoryKinesisStreamMapping requires startingPositionTimestamp when startingPosition is AT_TIMESTAMP",
    );
  }

  if (startingPositionTimestamp === undefined) {
    return;
  }

  if (startingPosition !== lambda.StartingPosition.AT_TIMESTAMP) {
    throw new Error(
      "AppTheoryKinesisStreamMapping only supports startingPositionTimestamp with startingPosition AT_TIMESTAMP",
    );
  }

  if (
    !Token.isUnresolved(startingPositionTimestamp) &&
    (!Number.isFinite(startingPositionTimestamp) || startingPositionTimestamp < 0)
  ) {
    throw new Error(
      "AppTheoryKinesisStreamMapping requires startingPositionTimestamp to be a non-negative Unix timestamp",
    );
  }
}
