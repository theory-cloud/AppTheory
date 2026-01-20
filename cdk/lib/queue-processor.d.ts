import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
export interface AppTheoryQueueProcessorProps {
    readonly consumer: lambda.Function;
    readonly queueProps?: sqs.QueueProps;
    readonly batchSize?: number;
    readonly maxBatchingWindow?: Duration;
}
export declare class AppTheoryQueueProcessor extends Construct {
    readonly queue: sqs.Queue;
    constructor(scope: Construct, id: string, props: AppTheoryQueueProcessorProps);
}
