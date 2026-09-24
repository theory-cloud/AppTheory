"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryQueue = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
const constructs_1 = require("constructs");
/**
 * A composable SQS queue construct with optional DLQ support.
 *
 * This construct creates an SQS queue with optional Dead Letter Queue (DLQ) configuration.
 * It can be used standalone (for manual message production/consumption) or composed
 * with AppTheoryQueueConsumer for Lambda integration.
 *
 * @example
 * // Queue with DLQ (default)
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 * });
 *
 * @example
 * // Queue without DLQ
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 *   enableDlq: false,
 * });
 *
 * @example
 * // Queue with custom DLQ configuration
 * const queue = new AppTheoryQueue(stack, 'Queue', {
 *   queueName: 'my-queue',
 *   maxReceiveCount: 5,
 *   dlqRetentionPeriod: Duration.days(14),
 * });
 */
class AppTheoryQueue extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryQueue", version: "4.4.0" };
    /**
     * The main SQS queue.
     */
    queue;
    /**
     * The Dead Letter Queue, if enabled.
     */
    deadLetterQueue;
    /**
     * The ARN of the main queue.
     */
    queueArn;
    /**
     * The URL of the main queue.
     */
    queueUrl;
    /**
     * The name of the main queue.
     */
    queueName;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const enableDlq = props.enableDlq !== false;
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.DESTROY;
        // Create DLQ if enabled
        if (enableDlq) {
            const dlqName = props.queueName ? `${props.queueName}-dlq` : undefined;
            this.deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue", {
                queueName: props.fifo && dlqName ? `${dlqName}.fifo` : dlqName,
                visibilityTimeout: props.dlqVisibilityTimeout ?? props.visibilityTimeout,
                retentionPeriod: props.dlqRetentionPeriod ?? aws_cdk_lib_1.Duration.days(14),
                encryption: props.encryption,
                encryptionMasterKey: props.encryptionMasterKey,
                enforceSSL: props.enforceSSL,
                fifo: props.fifo,
                contentBasedDeduplication: props.fifo ? props.contentBasedDeduplication : undefined,
                removalPolicy,
            });
        }
        // Create main queue
        this.queue = new sqs.Queue(this, "Queue", {
            queueName: props.fifo && props.queueName ? `${props.queueName}.fifo` : props.queueName,
            visibilityTimeout: props.visibilityTimeout,
            retentionPeriod: props.retentionPeriod,
            receiveMessageWaitTime: props.receiveMessageWaitTime,
            encryption: props.encryption,
            encryptionMasterKey: props.encryptionMasterKey,
            enforceSSL: props.enforceSSL,
            fifo: props.fifo,
            contentBasedDeduplication: props.fifo ? props.contentBasedDeduplication : undefined,
            deadLetterQueue: this.deadLetterQueue
                ? {
                    queue: this.deadLetterQueue,
                    maxReceiveCount: props.maxReceiveCount ?? 3,
                }
                : undefined,
            removalPolicy,
        });
        // Expose convenience properties
        this.queueArn = this.queue.queueArn;
        this.queueUrl = this.queue.queueUrl;
        this.queueName = this.queue.queueName;
        // Grant send permissions if specified
        if (props.grantSendMessagesTo) {
            for (const fn of props.grantSendMessagesTo) {
                this.queue.grantSendMessages(fn);
            }
        }
    }
    /**
     * Grant send messages permission to a Lambda function.
     */
    grantSendMessages(grantee) {
        this.queue.grantSendMessages(grantee);
    }
    /**
     * Grant consume messages permission to a Lambda function.
     */
    grantConsumeMessages(grantee) {
        this.queue.grantConsumeMessages(grantee);
    }
    /**
     * Grant purge messages permission to a Lambda function.
     */
    grantPurge(grantee) {
        this.queue.grantPurge(grantee);
    }
}
exports.AppTheoryQueue = AppTheoryQueue;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicXVldWUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJxdWV1ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXNEO0FBR3RELHlEQUEyQztBQUMzQywyQ0FBdUM7QUFvR3ZDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0EyQkc7QUFDSCxNQUFhLGNBQWUsU0FBUSxzQkFBUzs7SUFDekM7O09BRUc7SUFDYSxLQUFLLENBQVk7SUFFakM7O09BRUc7SUFDYSxlQUFlLENBQWE7SUFFNUM7O09BRUc7SUFDYSxRQUFRLENBQVM7SUFFakM7O09BRUc7SUFDYSxRQUFRLENBQVM7SUFFakM7O09BRUc7SUFDYSxTQUFTLENBQVM7SUFFbEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUE2QixFQUFFO1FBQ3JFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxLQUFLLENBQUM7UUFDNUMsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSwyQkFBYSxDQUFDLE9BQU8sQ0FBQztRQUVuRSx3QkFBd0I7UUFDeEIsSUFBSSxTQUFTLEVBQUUsQ0FBQztZQUNaLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLFNBQVMsTUFBTSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7WUFDdkUsSUFBSSxDQUFDLGVBQWUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO2dCQUMxRCxTQUFTLEVBQUUsS0FBSyxDQUFDLElBQUksSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxPQUFPLENBQUMsQ0FBQyxDQUFDLE9BQU87Z0JBQzlELGlCQUFpQixFQUFFLEtBQUssQ0FBQyxvQkFBb0IsSUFBSSxLQUFLLENBQUMsaUJBQWlCO2dCQUN4RSxlQUFlLEVBQUUsS0FBSyxDQUFDLGtCQUFrQixJQUFJLHNCQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDOUQsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVO2dCQUM1QixtQkFBbUIsRUFBRSxLQUFLLENBQUMsbUJBQW1CO2dCQUM5QyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7Z0JBQzVCLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtnQkFDaEIseUJBQXlCLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLHlCQUF5QixDQUFDLENBQUMsQ0FBQyxTQUFTO2dCQUNuRixhQUFhO2FBQ2hCLENBQUMsQ0FBQztRQUNQLENBQUM7UUFFRCxvQkFBb0I7UUFDcEIsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUN0QyxTQUFTLEVBQUUsS0FBSyxDQUFDLElBQUksSUFBSSxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxTQUFTLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVM7WUFDdEYsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtZQUMxQyxlQUFlLEVBQUUsS0FBSyxDQUFDLGVBQWU7WUFDdEMsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQjtZQUNwRCxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsbUJBQW1CLEVBQUUsS0FBSyxDQUFDLG1CQUFtQjtZQUM5QyxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7WUFDNUIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLHlCQUF5QixFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDLENBQUMsU0FBUztZQUNuRixlQUFlLEVBQUUsSUFBSSxDQUFDLGVBQWU7Z0JBQ2pDLENBQUMsQ0FBQztvQkFDRSxLQUFLLEVBQUUsSUFBSSxDQUFDLGVBQWU7b0JBQzNCLGVBQWUsRUFBRSxLQUFLLENBQUMsZUFBZSxJQUFJLENBQUM7aUJBQzlDO2dCQUNELENBQUMsQ0FBQyxTQUFTO1lBQ2YsYUFBYTtTQUNoQixDQUFDLENBQUM7UUFFSCxnQ0FBZ0M7UUFDaEMsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQztRQUNwQyxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDO1FBQ3BDLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUM7UUFFdEMsc0NBQXNDO1FBQ3RDLElBQUksS0FBSyxDQUFDLG1CQUFtQixFQUFFLENBQUM7WUFDNUIsS0FBSyxNQUFNLEVBQUUsSUFBSSxLQUFLLENBQUMsbUJBQW1CLEVBQUUsQ0FBQztnQkFDekMsSUFBSSxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUNyQyxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFFRDs7T0FFRztJQUNJLGlCQUFpQixDQUFDLE9BQXlCO1FBQzlDLElBQUksQ0FBQyxLQUFLLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUVEOztPQUVHO0lBQ0ksb0JBQW9CLENBQUMsT0FBeUI7UUFDakQsSUFBSSxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM3QyxDQUFDO0lBRUQ7O09BRUc7SUFDSSxVQUFVLENBQUMsT0FBeUI7UUFDdkMsSUFBSSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbkMsQ0FBQzs7QUFwR0wsd0NBcUdDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgc3FzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtc3FzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIEFwcFRoZW9yeVF1ZXVlIGNvbnN0cnVjdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlRdWV1ZVByb3BzIHtcbiAgICAvKipcbiAgICAgKiBUaGUgbmFtZSBvZiB0aGUgcXVldWUuXG4gICAgICogQGRlZmF1bHQgLSBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHF1ZXVlTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFRoZSB2aXNpYmlsaXR5IHRpbWVvdXQgZm9yIG1lc3NhZ2VzIGluIHRoZSBxdWV1ZS5cbiAgICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5zZWNvbmRzKDMwKVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHZpc2liaWxpdHlUaW1lb3V0PzogRHVyYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgbnVtYmVyIG9mIHNlY29uZHMgdGhhdCBBbWF6b24gU1FTIHJldGFpbnMgYSBtZXNzYWdlLlxuICAgICAqIEBkZWZhdWx0IER1cmF0aW9uLmRheXMoNClcbiAgICAgKi9cbiAgICByZWFkb25seSByZXRlbnRpb25QZXJpb2Q/OiBEdXJhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBhbW91bnQgb2YgdGltZSBmb3Igd2hpY2ggYSBSZWNlaXZlTWVzc2FnZSBjYWxsIHdpbGwgd2FpdCBmb3IgYSBtZXNzYWdlIHRvIGFycml2ZSBpbiB0aGUgcXVldWVcbiAgICAgKiBiZWZvcmUgcmV0dXJuaW5nLiBVc2VkIGZvciBTUVMgbG9uZyBwb2xsaW5nLlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlY2VpdmVNZXNzYWdlV2FpdFRpbWU/OiBEdXJhdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gZW5hYmxlIGEgRGVhZCBMZXR0ZXIgUXVldWUgKERMUSkuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZURscT86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBUaGUgbWF4aW11bSBudW1iZXIgb2YgdGltZXMgYSBtZXNzYWdlIGNhbiBiZSByZWNlaXZlZCBiZWZvcmUgYmVpbmcgc2VudCB0byB0aGUgRExRLlxuICAgICAqIE9ubHkgYXBwbGljYWJsZSB3aGVuIGVuYWJsZURscSBpcyB0cnVlLlxuICAgICAqIEBkZWZhdWx0IDNcbiAgICAgKi9cbiAgICByZWFkb25seSBtYXhSZWNlaXZlQ291bnQ/OiBudW1iZXI7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgdmlzaWJpbGl0eSB0aW1lb3V0IGZvciB0aGUgRExRLlxuICAgICAqIEBkZWZhdWx0IC0gU2FtZSBhcyB0aGUgbWFpbiBxdWV1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRscVZpc2liaWxpdHlUaW1lb3V0PzogRHVyYXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgcmV0ZW50aW9uIHBlcmlvZCBmb3IgdGhlIERMUS5cbiAgICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5kYXlzKDE0KVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRscVJldGVudGlvblBlcmlvZD86IER1cmF0aW9uO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciBtZXNzYWdlcyBkZWxpdmVyZWQgdG8gdGhlIHF1ZXVlIHdpbGwgYmUgZW5jcnlwdGVkLlxuICAgICAqIEBkZWZhdWx0IC0gQVdTIG1hbmFnZWQgZW5jcnlwdGlvbiBpcyB1c2VkXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5jcnlwdGlvbj86IHNxcy5RdWV1ZUVuY3J5cHRpb247XG5cbiAgICAvKipcbiAgICAgKiBFeHRlcm5hbCBLTVMga2V5IHRvIHVzZSBmb3IgcXVldWUgZW5jcnlwdGlvbiB3aGVuIHlvdSByZXF1aXJlIGEgY3VzdG9tZXItbWFuYWdlZCBrZXkuXG4gICAgICogQGRlZmF1bHQgLSBubyBjdXN0b21lci1tYW5hZ2VkIEtNUyBrZXlcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmNyeXB0aW9uTWFzdGVyS2V5Pzoga21zLklLZXk7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhIHF1ZXVlIHBvbGljeSB0aGF0IGRlbmllcyBub24tVExTIHJlcXVlc3RzLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5mb3JjZVNTTD86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGVuYWJsZSBjb250ZW50LWJhc2VkIGRlZHVwbGljYXRpb24gZm9yIEZJRk8gcXVldWVzLlxuICAgICAqIE9ubHkgYXBwbGljYWJsZSBmb3IgRklGTyBxdWV1ZXMuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjb250ZW50QmFzZWREZWR1cGxpY2F0aW9uPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdGhlIHF1ZXVlIGlzIGEgRklGTyBxdWV1ZS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGZpZm8/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogUHJpbmNpcGFscyB0byBncmFudCBzZW5kIG1lc3NhZ2VzIHBlcm1pc3Npb24gdG8uXG4gICAgICogQGRlZmF1bHQgLSBObyBhZGRpdGlvbmFsIHByaW5jaXBhbHNcbiAgICAgKi9cbiAgICByZWFkb25seSBncmFudFNlbmRNZXNzYWdlc1RvPzogbGFtYmRhLklGdW5jdGlvbltdO1xuXG4gICAgLyoqXG4gICAgICogVGhlIHJlbW92YWwgcG9saWN5IGZvciB0aGUgcXVldWUocykuXG4gICAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5ERVNUUk9ZXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG59XG5cbi8qKlxuICogQSBjb21wb3NhYmxlIFNRUyBxdWV1ZSBjb25zdHJ1Y3Qgd2l0aCBvcHRpb25hbCBETFEgc3VwcG9ydC5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBjcmVhdGVzIGFuIFNRUyBxdWV1ZSB3aXRoIG9wdGlvbmFsIERlYWQgTGV0dGVyIFF1ZXVlIChETFEpIGNvbmZpZ3VyYXRpb24uXG4gKiBJdCBjYW4gYmUgdXNlZCBzdGFuZGFsb25lIChmb3IgbWFudWFsIG1lc3NhZ2UgcHJvZHVjdGlvbi9jb25zdW1wdGlvbikgb3IgY29tcG9zZWRcbiAqIHdpdGggQXBwVGhlb3J5UXVldWVDb25zdW1lciBmb3IgTGFtYmRhIGludGVncmF0aW9uLlxuICpcbiAqIEBleGFtcGxlXG4gKiAvLyBRdWV1ZSB3aXRoIERMUSAoZGVmYXVsdClcbiAqIGNvbnN0IHF1ZXVlID0gbmV3IEFwcFRoZW9yeVF1ZXVlKHN0YWNrLCAnUXVldWUnLCB7XG4gKiAgIHF1ZXVlTmFtZTogJ215LXF1ZXVlJyxcbiAqIH0pO1xuICpcbiAqIEBleGFtcGxlXG4gKiAvLyBRdWV1ZSB3aXRob3V0IERMUVxuICogY29uc3QgcXVldWUgPSBuZXcgQXBwVGhlb3J5UXVldWUoc3RhY2ssICdRdWV1ZScsIHtcbiAqICAgcXVldWVOYW1lOiAnbXktcXVldWUnLFxuICogICBlbmFibGVEbHE6IGZhbHNlLFxuICogfSk7XG4gKlxuICogQGV4YW1wbGVcbiAqIC8vIFF1ZXVlIHdpdGggY3VzdG9tIERMUSBjb25maWd1cmF0aW9uXG4gKiBjb25zdCBxdWV1ZSA9IG5ldyBBcHBUaGVvcnlRdWV1ZShzdGFjaywgJ1F1ZXVlJywge1xuICogICBxdWV1ZU5hbWU6ICdteS1xdWV1ZScsXG4gKiAgIG1heFJlY2VpdmVDb3VudDogNSxcbiAqICAgZGxxUmV0ZW50aW9uUGVyaW9kOiBEdXJhdGlvbi5kYXlzKDE0KSxcbiAqIH0pO1xuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UXVldWUgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSBtYWluIFNRUyBxdWV1ZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcXVldWU6IHNxcy5RdWV1ZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBEZWFkIExldHRlciBRdWV1ZSwgaWYgZW5hYmxlZC5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZGVhZExldHRlclF1ZXVlPzogc3FzLlF1ZXVlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIEFSTiBvZiB0aGUgbWFpbiBxdWV1ZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcXVldWVBcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFRoZSBVUkwgb2YgdGhlIG1haW4gcXVldWUuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHF1ZXVlVXJsOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgbmFtZSBvZiB0aGUgbWFpbiBxdWV1ZS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcXVldWVOYW1lOiBzdHJpbmc7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UXVldWVQcm9wcyA9IHt9KSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgY29uc3QgZW5hYmxlRGxxID0gcHJvcHMuZW5hYmxlRGxxICE9PSBmYWxzZTtcbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5ERVNUUk9ZO1xuXG4gICAgICAgIC8vIENyZWF0ZSBETFEgaWYgZW5hYmxlZFxuICAgICAgICBpZiAoZW5hYmxlRGxxKSB7XG4gICAgICAgICAgICBjb25zdCBkbHFOYW1lID0gcHJvcHMucXVldWVOYW1lID8gYCR7cHJvcHMucXVldWVOYW1lfS1kbHFgIDogdW5kZWZpbmVkO1xuICAgICAgICAgICAgdGhpcy5kZWFkTGV0dGVyUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsIFwiRGVhZExldHRlclF1ZXVlXCIsIHtcbiAgICAgICAgICAgICAgICBxdWV1ZU5hbWU6IHByb3BzLmZpZm8gJiYgZGxxTmFtZSA/IGAke2RscU5hbWV9LmZpZm9gIDogZGxxTmFtZSxcbiAgICAgICAgICAgICAgICB2aXNpYmlsaXR5VGltZW91dDogcHJvcHMuZGxxVmlzaWJpbGl0eVRpbWVvdXQgPz8gcHJvcHMudmlzaWJpbGl0eVRpbWVvdXQsXG4gICAgICAgICAgICAgICAgcmV0ZW50aW9uUGVyaW9kOiBwcm9wcy5kbHFSZXRlbnRpb25QZXJpb2QgPz8gRHVyYXRpb24uZGF5cygxNCksXG4gICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogcHJvcHMuZW5jcnlwdGlvbixcbiAgICAgICAgICAgICAgICBlbmNyeXB0aW9uTWFzdGVyS2V5OiBwcm9wcy5lbmNyeXB0aW9uTWFzdGVyS2V5LFxuICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHByb3BzLmVuZm9yY2VTU0wsXG4gICAgICAgICAgICAgICAgZmlmbzogcHJvcHMuZmlmbyxcbiAgICAgICAgICAgICAgICBjb250ZW50QmFzZWREZWR1cGxpY2F0aW9uOiBwcm9wcy5maWZvID8gcHJvcHMuY29udGVudEJhc2VkRGVkdXBsaWNhdGlvbiA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgbWFpbiBxdWV1ZVxuICAgICAgICB0aGlzLnF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBcIlF1ZXVlXCIsIHtcbiAgICAgICAgICAgIHF1ZXVlTmFtZTogcHJvcHMuZmlmbyAmJiBwcm9wcy5xdWV1ZU5hbWUgPyBgJHtwcm9wcy5xdWV1ZU5hbWV9LmZpZm9gIDogcHJvcHMucXVldWVOYW1lLFxuICAgICAgICAgICAgdmlzaWJpbGl0eVRpbWVvdXQ6IHByb3BzLnZpc2liaWxpdHlUaW1lb3V0LFxuICAgICAgICAgICAgcmV0ZW50aW9uUGVyaW9kOiBwcm9wcy5yZXRlbnRpb25QZXJpb2QsXG4gICAgICAgICAgICByZWNlaXZlTWVzc2FnZVdhaXRUaW1lOiBwcm9wcy5yZWNlaXZlTWVzc2FnZVdhaXRUaW1lLFxuICAgICAgICAgICAgZW5jcnlwdGlvbjogcHJvcHMuZW5jcnlwdGlvbixcbiAgICAgICAgICAgIGVuY3J5cHRpb25NYXN0ZXJLZXk6IHByb3BzLmVuY3J5cHRpb25NYXN0ZXJLZXksXG4gICAgICAgICAgICBlbmZvcmNlU1NMOiBwcm9wcy5lbmZvcmNlU1NMLFxuICAgICAgICAgICAgZmlmbzogcHJvcHMuZmlmbyxcbiAgICAgICAgICAgIGNvbnRlbnRCYXNlZERlZHVwbGljYXRpb246IHByb3BzLmZpZm8gPyBwcm9wcy5jb250ZW50QmFzZWREZWR1cGxpY2F0aW9uIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgZGVhZExldHRlclF1ZXVlOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICBxdWV1ZTogdGhpcy5kZWFkTGV0dGVyUXVldWUsXG4gICAgICAgICAgICAgICAgICAgIG1heFJlY2VpdmVDb3VudDogcHJvcHMubWF4UmVjZWl2ZUNvdW50ID8/IDMsXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gRXhwb3NlIGNvbnZlbmllbmNlIHByb3BlcnRpZXNcbiAgICAgICAgdGhpcy5xdWV1ZUFybiA9IHRoaXMucXVldWUucXVldWVBcm47XG4gICAgICAgIHRoaXMucXVldWVVcmwgPSB0aGlzLnF1ZXVlLnF1ZXVlVXJsO1xuICAgICAgICB0aGlzLnF1ZXVlTmFtZSA9IHRoaXMucXVldWUucXVldWVOYW1lO1xuXG4gICAgICAgIC8vIEdyYW50IHNlbmQgcGVybWlzc2lvbnMgaWYgc3BlY2lmaWVkXG4gICAgICAgIGlmIChwcm9wcy5ncmFudFNlbmRNZXNzYWdlc1RvKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZuIG9mIHByb3BzLmdyYW50U2VuZE1lc3NhZ2VzVG8pIHtcbiAgICAgICAgICAgICAgICB0aGlzLnF1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGZuKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdyYW50IHNlbmQgbWVzc2FnZXMgcGVybWlzc2lvbiB0byBhIExhbWJkYSBmdW5jdGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgZ3JhbnRTZW5kTWVzc2FnZXMoZ3JhbnRlZTogbGFtYmRhLklGdW5jdGlvbik6IHZvaWQge1xuICAgICAgICB0aGlzLnF1ZXVlLmdyYW50U2VuZE1lc3NhZ2VzKGdyYW50ZWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdyYW50IGNvbnN1bWUgbWVzc2FnZXMgcGVybWlzc2lvbiB0byBhIExhbWJkYSBmdW5jdGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgZ3JhbnRDb25zdW1lTWVzc2FnZXMoZ3JhbnRlZTogbGFtYmRhLklGdW5jdGlvbik6IHZvaWQge1xuICAgICAgICB0aGlzLnF1ZXVlLmdyYW50Q29uc3VtZU1lc3NhZ2VzKGdyYW50ZWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdyYW50IHB1cmdlIG1lc3NhZ2VzIHBlcm1pc3Npb24gdG8gYSBMYW1iZGEgZnVuY3Rpb24uXG4gICAgICovXG4gICAgcHVibGljIGdyYW50UHVyZ2UoZ3JhbnRlZTogbGFtYmRhLklGdW5jdGlvbik6IHZvaWQge1xuICAgICAgICB0aGlzLnF1ZXVlLmdyYW50UHVyZ2UoZ3JhbnRlZSk7XG4gICAgfVxufVxuIl19