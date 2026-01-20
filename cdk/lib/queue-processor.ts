import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface AppTheoryQueueProcessorProps {
  readonly consumer: lambda.Function;
  readonly queueProps?: sqs.QueueProps;
  readonly batchSize?: number;
  readonly maxBatchingWindow?: Duration;
}

export class AppTheoryQueueProcessor extends Construct {
  public readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: AppTheoryQueueProcessorProps) {
    super(scope, id);

    this.queue = new sqs.Queue(this, "Queue", props.queueProps);

    props.consumer.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: props.batchSize ?? 10,
        maxBatchingWindow: props.maxBatchingWindow,
      }),
    );

    this.queue.grantConsumeMessages(props.consumer);
  }
}

