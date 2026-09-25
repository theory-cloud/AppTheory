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
exports.AppTheoryKinesisStreamMapping = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaEventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
const constructs_1 = require("constructs");
/**
 * Wires a Kinesis Data Stream to a Lambda consumer.
 *
 * The mapping owns no stream lifecycle. Use AppTheoryKinesisStream when the
 * application should create or wrap the stream, then pass its `stream` here.
 */
class AppTheoryKinesisStreamMapping extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryKinesisStreamMapping", version: "4.4.2-rc" };
    constructor(scope, id, props) {
        super(scope, id);
        const startingPosition = props.startingPosition ?? lambda.StartingPosition.LATEST;
        validateStartingPositionTimestamp(startingPosition, props.startingPositionTimestamp);
        props.consumer.addEventSource(new lambdaEventSources.KinesisEventSource(props.stream, {
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
        }));
        props.stream.grantRead(props.consumer);
    }
}
exports.AppTheoryKinesisStreamMapping = AppTheoryKinesisStreamMapping;
function validateStartingPositionTimestamp(startingPosition, startingPositionTimestamp) {
    if (startingPosition === lambda.StartingPosition.AT_TIMESTAMP && startingPositionTimestamp === undefined) {
        throw new Error("AppTheoryKinesisStreamMapping requires startingPositionTimestamp when startingPosition is AT_TIMESTAMP");
    }
    if (startingPositionTimestamp === undefined) {
        return;
    }
    if (startingPosition !== lambda.StartingPosition.AT_TIMESTAMP) {
        throw new Error("AppTheoryKinesisStreamMapping only supports startingPositionTimestamp with startingPosition AT_TIMESTAMP");
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(startingPositionTimestamp) &&
        (!Number.isFinite(startingPositionTimestamp) || startingPositionTimestamp < 0)) {
        throw new Error("AppTheoryKinesisStreamMapping requires startingPositionTimestamp to be a non-negative Unix timestamp");
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoia2luZXNpcy1zdHJlYW0tbWFwcGluZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImtpbmVzaXMtc3RyZWFtLW1hcHBpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFvQztBQUdwQywrREFBaUQ7QUFDakQseUZBQTJFO0FBQzNFLDJDQUF1QztBQTBGdkM7Ozs7O0dBS0c7QUFDSCxNQUFhLDZCQUE4QixTQUFRLHNCQUFTOztJQUMxRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlDO1FBQ2pGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxnQkFBZ0IsR0FBRyxLQUFLLENBQUMsZ0JBQWdCLElBQUksTUFBTSxDQUFDLGdCQUFnQixDQUFDLE1BQU0sQ0FBQztRQUNsRixpQ0FBaUMsQ0FBQyxnQkFBZ0IsRUFBRSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztRQUVyRixLQUFLLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FDM0IsSUFBSSxrQkFBa0IsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFO1lBQ3RELGdCQUFnQjtZQUNoQix5QkFBeUIsRUFBRSxLQUFLLENBQUMseUJBQXlCO1lBQzFELFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztZQUMxQixpQkFBaUIsRUFBRSxLQUFLLENBQUMsaUJBQWlCO1lBQzFDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTtZQUNsQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVk7WUFDaEMsa0JBQWtCLEVBQUUsS0FBSyxDQUFDLGtCQUFrQjtZQUM1QyxxQkFBcUIsRUFBRSxLQUFLLENBQUMscUJBQXFCO1lBQ2xELHVCQUF1QixFQUFFLEtBQUssQ0FBQyx1QkFBdUIsSUFBSSxJQUFJO1lBQzlELGNBQWMsRUFBRSxLQUFLLENBQUMsY0FBYztTQUNyQyxDQUFDLENBQ0gsQ0FBQztRQUVGLEtBQUssQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN6QyxDQUFDOztBQXZCSCxzRUF3QkM7QUFFRCxTQUFTLGlDQUFpQyxDQUN4QyxnQkFBeUMsRUFDekMseUJBQWtDO0lBRWxDLElBQUksZ0JBQWdCLEtBQUssTUFBTSxDQUFDLGdCQUFnQixDQUFDLFlBQVksSUFBSSx5QkFBeUIsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUN6RyxNQUFNLElBQUksS0FBSyxDQUNiLHdHQUF3RyxDQUN6RyxDQUFDO0lBQ0osQ0FBQztJQUVELElBQUkseUJBQXlCLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDNUMsT0FBTztJQUNULENBQUM7SUFFRCxJQUFJLGdCQUFnQixLQUFLLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUM5RCxNQUFNLElBQUksS0FBSyxDQUNiLDBHQUEwRyxDQUMzRyxDQUFDO0lBQ0osQ0FBQztJQUVELElBQ0UsQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyx5QkFBeUIsQ0FBQztRQUM5QyxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyx5QkFBeUIsQ0FBQyxJQUFJLHlCQUF5QixHQUFHLENBQUMsQ0FBQyxFQUM5RSxDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYixzR0FBc0csQ0FDdkcsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB0eXBlIHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB0eXBlICogYXMga2luZXNpcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWtpbmVzaXNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbGFtYmRhRXZlbnRTb3VyY2VzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbi8qKlxuICogUHJvcGVydGllcyBmb3IgQXBwVGhlb3J5S2luZXNpc1N0cmVhbU1hcHBpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5S2luZXNpc1N0cmVhbU1hcHBpbmdQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgTGFtYmRhIGZ1bmN0aW9uIHRoYXQgd2lsbCBjb25zdW1lIHJlY29yZHMgZnJvbSB0aGUgc3RyZWFtLlxuICAgKi9cbiAgcmVhZG9ubHkgY29uc3VtZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBLaW5lc2lzIERhdGEgU3RyZWFtIHRvIGNvbnN1bWUuXG4gICAqL1xuICByZWFkb25seSBzdHJlYW06IGtpbmVzaXMuSVN0cmVhbTtcblxuICAvKipcbiAgICogV2hlcmUgdG8gYmVnaW4gY29uc3VtaW5nIHRoZSBzdHJlYW0uXG4gICAqXG4gICAqIEBkZWZhdWx0IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLkxBVEVTVFxuICAgKi9cbiAgcmVhZG9ubHkgc3RhcnRpbmdQb3NpdGlvbj86IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgVW5peCB0aW1lc3RhbXAsIGluIHNlY29uZHMsIHVzZWQgd2l0aCBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbi5BVF9USU1FU1RBTVAuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gbm8gdGltZXN0YW1wXG4gICAqL1xuICByZWFkb25seSBzdGFydGluZ1Bvc2l0aW9uVGltZXN0YW1wPzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaGUgbGFyZ2VzdCBudW1iZXIgb2YgcmVjb3JkcyB0aGF0IEFXUyBMYW1iZGEgcmV0cmlldmVzIHBlciBpbnZvY2F0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIEFXUyBMYW1iZGEgZGVmYXVsdCBmb3IgS2luZXNpcyBldmVudCBzb3VyY2UgbWFwcGluZ3NcbiAgICovXG4gIHJlYWRvbmx5IGJhdGNoU2l6ZT86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gYW1vdW50IG9mIHRpbWUgdG8gZ2F0aGVyIHJlY29yZHMgYmVmb3JlIGludm9raW5nIHRoZSBmdW5jdGlvbi5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgTGFtYmRhIGRlZmF1bHQgZm9yIEtpbmVzaXMgZXZlbnQgc291cmNlIG1hcHBpbmdzXG4gICAqL1xuICByZWFkb25seSBtYXhCYXRjaGluZ1dpbmRvdz86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBNYXhpbXVtIG51bWJlciBvZiByZXRyeSBhdHRlbXB0cyBmb3IgZmFpbGVkIHJlY29yZHMuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gQVdTIExhbWJkYSBkZWZhdWx0IGZvciBLaW5lc2lzIGV2ZW50IHNvdXJjZSBtYXBwaW5nc1xuICAgKi9cbiAgcmVhZG9ubHkgcmV0cnlBdHRlbXB0cz86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhlIG1heGltdW0gYWdlIG9mIGEgcmVjb3JkIHRoYXQgTGFtYmRhIHNlbmRzIHRvIHRoZSBjb25zdW1lci5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgTGFtYmRhIGRlZmF1bHQgZm9yIEtpbmVzaXMgZXZlbnQgc291cmNlIG1hcHBpbmdzXG4gICAqL1xuICByZWFkb25seSBtYXhSZWNvcmRBZ2U/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogU3BsaXQgYSBmYWlsZWQgYmF0Y2ggaW4gdHdvIGFuZCByZXRyeS5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgTGFtYmRhIGRlZmF1bHQgZm9yIEtpbmVzaXMgZXZlbnQgc291cmNlIG1hcHBpbmdzXG4gICAqL1xuICByZWFkb25seSBiaXNlY3RCYXRjaE9uRXJyb3I/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBUaGUgbnVtYmVyIG9mIGJhdGNoZXMgdG8gcHJvY2VzcyBmcm9tIGVhY2ggc2hhcmQgY29uY3VycmVudGx5LlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIEFXUyBMYW1iZGEgZGVmYXVsdCBmb3IgS2luZXNpcyBldmVudCBzb3VyY2UgbWFwcGluZ3NcbiAgICovXG4gIHJlYWRvbmx5IHBhcmFsbGVsaXphdGlvbkZhY3Rvcj86IG51bWJlcjtcblxuICAvKipcbiAgICogQWxsb3cgcGFydGlhbC1iYXRjaCBmYWlsdXJlIHJlc3BvbnNlcyBmcm9tIHRoZSBjb25zdW1lci5cbiAgICpcbiAgICogQXBwVGhlb3J5IGRlZmF1bHRzIHRoaXMgb24gc28gS2luZXNpcyBjb25zdW1lcnMgY2FuIGZhaWwgY2xvc2VkIHBlciByZWNvcmRcbiAgICogaW5zdGVhZCBvZiByZXBsYXlpbmcgc3VjY2Vzc2Z1bGx5IHByb2Nlc3NlZCByZWNvcmRzLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSByZXBvcnRCYXRjaEl0ZW1GYWlsdXJlcz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRoZSB0dW1ibGluZyB3aW5kb3cgdXNlZCB0byBncm91cCByZWNvcmRzIGJlZm9yZSBpbnZvY2F0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIG5vIHR1bWJsaW5nIHdpbmRvd1xuICAgKi9cbiAgcmVhZG9ubHkgdHVtYmxpbmdXaW5kb3c/OiBEdXJhdGlvbjtcbn1cblxuLyoqXG4gKiBXaXJlcyBhIEtpbmVzaXMgRGF0YSBTdHJlYW0gdG8gYSBMYW1iZGEgY29uc3VtZXIuXG4gKlxuICogVGhlIG1hcHBpbmcgb3ducyBubyBzdHJlYW0gbGlmZWN5Y2xlLiBVc2UgQXBwVGhlb3J5S2luZXNpc1N0cmVhbSB3aGVuIHRoZVxuICogYXBwbGljYXRpb24gc2hvdWxkIGNyZWF0ZSBvciB3cmFwIHRoZSBzdHJlYW0sIHRoZW4gcGFzcyBpdHMgYHN0cmVhbWAgaGVyZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUtpbmVzaXNTdHJlYW1NYXBwaW5nIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUtpbmVzaXNTdHJlYW1NYXBwaW5nUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgc3RhcnRpbmdQb3NpdGlvbiA9IHByb3BzLnN0YXJ0aW5nUG9zaXRpb24gPz8gbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uTEFURVNUO1xuICAgIHZhbGlkYXRlU3RhcnRpbmdQb3NpdGlvblRpbWVzdGFtcChzdGFydGluZ1Bvc2l0aW9uLCBwcm9wcy5zdGFydGluZ1Bvc2l0aW9uVGltZXN0YW1wKTtcblxuICAgIHByb3BzLmNvbnN1bWVyLmFkZEV2ZW50U291cmNlKFxuICAgICAgbmV3IGxhbWJkYUV2ZW50U291cmNlcy5LaW5lc2lzRXZlbnRTb3VyY2UocHJvcHMuc3RyZWFtLCB7XG4gICAgICAgIHN0YXJ0aW5nUG9zaXRpb24sXG4gICAgICAgIHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXA6IHByb3BzLnN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXAsXG4gICAgICAgIGJhdGNoU2l6ZTogcHJvcHMuYmF0Y2hTaXplLFxuICAgICAgICBtYXhCYXRjaGluZ1dpbmRvdzogcHJvcHMubWF4QmF0Y2hpbmdXaW5kb3csXG4gICAgICAgIHJldHJ5QXR0ZW1wdHM6IHByb3BzLnJldHJ5QXR0ZW1wdHMsXG4gICAgICAgIG1heFJlY29yZEFnZTogcHJvcHMubWF4UmVjb3JkQWdlLFxuICAgICAgICBiaXNlY3RCYXRjaE9uRXJyb3I6IHByb3BzLmJpc2VjdEJhdGNoT25FcnJvcixcbiAgICAgICAgcGFyYWxsZWxpemF0aW9uRmFjdG9yOiBwcm9wcy5wYXJhbGxlbGl6YXRpb25GYWN0b3IsXG4gICAgICAgIHJlcG9ydEJhdGNoSXRlbUZhaWx1cmVzOiBwcm9wcy5yZXBvcnRCYXRjaEl0ZW1GYWlsdXJlcyA/PyB0cnVlLFxuICAgICAgICB0dW1ibGluZ1dpbmRvdzogcHJvcHMudHVtYmxpbmdXaW5kb3csXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgcHJvcHMuc3RyZWFtLmdyYW50UmVhZChwcm9wcy5jb25zdW1lcik7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVTdGFydGluZ1Bvc2l0aW9uVGltZXN0YW1wKFxuICBzdGFydGluZ1Bvc2l0aW9uOiBsYW1iZGEuU3RhcnRpbmdQb3NpdGlvbixcbiAgc3RhcnRpbmdQb3NpdGlvblRpbWVzdGFtcD86IG51bWJlcixcbik6IHZvaWQge1xuICBpZiAoc3RhcnRpbmdQb3NpdGlvbiA9PT0gbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uQVRfVElNRVNUQU1QICYmIHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXAgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5S2luZXNpc1N0cmVhbU1hcHBpbmcgcmVxdWlyZXMgc3RhcnRpbmdQb3NpdGlvblRpbWVzdGFtcCB3aGVuIHN0YXJ0aW5nUG9zaXRpb24gaXMgQVRfVElNRVNUQU1QXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmIChzdGFydGluZ1Bvc2l0aW9uVGltZXN0YW1wID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoc3RhcnRpbmdQb3NpdGlvbiAhPT0gbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uQVRfVElNRVNUQU1QKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlLaW5lc2lzU3RyZWFtTWFwcGluZyBvbmx5IHN1cHBvcnRzIHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXAgd2l0aCBzdGFydGluZ1Bvc2l0aW9uIEFUX1RJTUVTVEFNUFwiLFxuICAgICk7XG4gIH1cblxuICBpZiAoXG4gICAgIVRva2VuLmlzVW5yZXNvbHZlZChzdGFydGluZ1Bvc2l0aW9uVGltZXN0YW1wKSAmJlxuICAgICghTnVtYmVyLmlzRmluaXRlKHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXApIHx8IHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXAgPCAwKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeUtpbmVzaXNTdHJlYW1NYXBwaW5nIHJlcXVpcmVzIHN0YXJ0aW5nUG9zaXRpb25UaW1lc3RhbXAgdG8gYmUgYSBub24tbmVnYXRpdmUgVW5peCB0aW1lc3RhbXBcIixcbiAgICApO1xuICB9XG59XG4iXX0=