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
exports.AppTheoryDynamoDBStreamMapping = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaEventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
const constructs_1 = require("constructs");
const stream_mapping_on_failure_1 = require("./private/stream-mapping-on-failure");
class AppTheoryDynamoDBStreamMapping extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryDynamoDBStreamMapping", version: "4.5.0-rc" };
    constructor(scope, id, props) {
        super(scope, id);
        (0, stream_mapping_on_failure_1.assertEventSourceDlq)("AppTheoryDynamoDBStreamMapping", props.onFailure);
        props.consumer.addEventSource(new lambdaEventSources.DynamoEventSource(props.table, {
            startingPosition: props.startingPosition ?? lambda.StartingPosition.LATEST,
            batchSize: props.batchSize,
            bisectBatchOnError: props.bisectBatchOnError,
            parallelizationFactor: props.parallelizationFactor,
            retryAttempts: props.retryAttempts,
            maxBatchingWindow: props.maxBatchingWindow,
            maxRecordAge: props.maxRecordAge,
            reportBatchItemFailures: props.reportBatchItemFailures ?? true,
            onFailure: props.onFailure,
        }));
    }
}
exports.AppTheoryDynamoDBStreamMapping = AppTheoryDynamoDBStreamMapping;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYW1vZGItc3RyZWFtLW1hcHBpbmcuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkeW5hbW9kYi1zdHJlYW0tbWFwcGluZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUEsK0RBQWlEO0FBQ2pELHlGQUEyRTtBQUMzRSwyQ0FBdUM7QUFFdkMsbUZBQTJFO0FBbUMzRSxNQUFhLDhCQUErQixTQUFRLHNCQUFTOztJQUMzRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQTBDO1FBQ2xGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBQSxnREFBb0IsRUFBQyxnQ0FBZ0MsRUFBRSxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFeEUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQzNCLElBQUksa0JBQWtCLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRTtZQUNwRCxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsZ0JBQWdCLElBQUksTUFBTSxDQUFDLGdCQUFnQixDQUFDLE1BQU07WUFDMUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLGtCQUFrQixFQUFFLEtBQUssQ0FBQyxrQkFBa0I7WUFDNUMscUJBQXFCLEVBQUUsS0FBSyxDQUFDLHFCQUFxQjtZQUNsRCxhQUFhLEVBQUUsS0FBSyxDQUFDLGFBQWE7WUFDbEMsaUJBQWlCLEVBQUUsS0FBSyxDQUFDLGlCQUFpQjtZQUMxQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVk7WUFDaEMsdUJBQXVCLEVBQUUsS0FBSyxDQUFDLHVCQUF1QixJQUFJLElBQUk7WUFDOUQsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1NBQzNCLENBQUMsQ0FDSCxDQUFDO0lBQ0osQ0FBQzs7QUFuQkgsd0VBb0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHR5cGUgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxhbWJkYUV2ZW50U291cmNlcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBhc3NlcnRFdmVudFNvdXJjZURscSB9IGZyb20gXCIuL3ByaXZhdGUvc3RyZWFtLW1hcHBpbmctb24tZmFpbHVyZVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUR5bmFtb0RCU3RyZWFtTWFwcGluZ1Byb3BzIHtcbiAgcmVhZG9ubHkgY29uc3VtZXI6IGxhbWJkYS5GdW5jdGlvbjtcbiAgcmVhZG9ubHkgdGFibGU6IGR5bmFtb2RiLklUYWJsZTtcbiAgcmVhZG9ubHkgc3RhcnRpbmdQb3NpdGlvbj86IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uO1xuICByZWFkb25seSBiYXRjaFNpemU/OiBudW1iZXI7XG4gIHJlYWRvbmx5IGJpc2VjdEJhdGNoT25FcnJvcj86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHBhcmFsbGVsaXphdGlvbkZhY3Rvcj86IG51bWJlcjtcbiAgcmVhZG9ubHkgcmV0cnlBdHRlbXB0cz86IG51bWJlcjtcbiAgcmVhZG9ubHkgbWF4QmF0Y2hpbmdXaW5kb3c/OiBEdXJhdGlvbjtcbiAgcmVhZG9ubHkgbWF4UmVjb3JkQWdlPzogRHVyYXRpb247XG4gIHJlYWRvbmx5IHJlcG9ydEJhdGNoSXRlbUZhaWx1cmVzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVzdGluYXRpb24gZm9yIHRoZSByZWNvcmRzIExhbWJkYSBkaXNjYXJkcyBhZnRlciByZXRyaWVzIGFyZSBleGhhdXN0ZWQgb3IgYG1heFJlY29yZEFnZWAgZWxhcHNlcy5cbiAgICpcbiAgICogUGFzcyBhbiBldmVudCBzb3VyY2UgRExRLCBzdWNoIGFzIGBuZXcgbGFtYmRhRXZlbnRTb3VyY2VzLlNxc0RscShxdWV1ZSlgIG9yXG4gICAqIGBuZXcgbGFtYmRhRXZlbnRTb3VyY2VzLlNuc0RscSh0b3BpYylgLiBCaW5kaW5nIHRoYXQgRExRIGdyYW50cyB0aGUgY29uc3VtZXIgcm9sZSBleGFjdGx5IHRoZVxuICAgKiBwZXJtaXNzaW9uIHRoZSBkZXN0aW5hdGlvbiBuZWVkcyAoYHNxczpTZW5kTWVzc2FnZWAgb3IgYHNuczpQdWJsaXNoYCk7IGFuIEFtYXpvbiBTMyBidWNrZXRcbiAgICogKGBuZXcgbGFtYmRhRXZlbnRTb3VyY2VzLlMzT25GYWlsdXJlRGVzdGluYXRpb24oYnVja2V0KWApIGlzIGFsc28gc3VwcG9ydGVkLlxuICAgKlxuICAgKiBUaGUgZGVzdGluYXRpb24gcmVjZWl2ZXMgbWV0YWRhdGEgYWJvdXQgdGhlIGRpc2NhcmRlZCBiYXRjaCwgbm90IHRoZSByZWNvcmRzIHRoZW1zZWx2ZXM6IHRoZVxuICAgKiBzaGFyZCBJRCBhbmQgc2VxdWVuY2UgbnVtYmVycyBpZGVudGlmeSByZWNvcmRzIHRvIHJlLXJlYWQgZnJvbSB0aGUgc3RyZWFtIHdoaWxlIHRoZXkgYXJlIHN0aWxsXG4gICAqIGluc2lkZSB0aGUgc3RyZWFtIHJldGVudGlvbiB3aW5kb3cuIEl0IG9ubHkgcmVjZWl2ZXMgYW55dGhpbmcgb25jZSByZXRyaWVzIGFyZSBleGhhdXN0ZWQgb3JcbiAgICogYG1heFJlY29yZEFnZWAgaXMgZXhjZWVkZWQsIHNvIGEgbWFwcGluZyB0aGF0IGxlYXZlcyBib3RoIHVuYm91bmRlZCAodGhlIEFXUyBMYW1iZGEgZGVmYXVsdCBpc1xuICAgKiBgLTFgLCByZXRyeSB1bnRpbCB0aGUgcmVjb3JkIGV4cGlyZXMpIGhhcyBub3RoaW5nIHRvIHNlbmQuIFBhaXIgdGhpcyBwcm9wIHdpdGggYSBib3VuZGVkXG4gICAqIGByZXRyeUF0dGVtcHRzYCBhbmQgYGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZWAgc28gYSBwb2lzb24gcmVjb3JkIGlzIHJldGFpbmVkIGZvciByZXBhaXIgaW5zdGVhZFxuICAgKiBvZiBibG9ja2luZyBpdHMgc2hhcmQuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gZGlzY2FyZGVkIHJlY29yZHMgYXJlIGRyb3BwZWRcbiAgICovXG4gIHJlYWRvbmx5IG9uRmFpbHVyZT86IGxhbWJkYS5JRXZlbnRTb3VyY2VEbHE7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlEeW5hbW9EQlN0cmVhbU1hcHBpbmcgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5RHluYW1vREJTdHJlYW1NYXBwaW5nUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgYXNzZXJ0RXZlbnRTb3VyY2VEbHEoXCJBcHBUaGVvcnlEeW5hbW9EQlN0cmVhbU1hcHBpbmdcIiwgcHJvcHMub25GYWlsdXJlKTtcblxuICAgIHByb3BzLmNvbnN1bWVyLmFkZEV2ZW50U291cmNlKFxuICAgICAgbmV3IGxhbWJkYUV2ZW50U291cmNlcy5EeW5hbW9FdmVudFNvdXJjZShwcm9wcy50YWJsZSwge1xuICAgICAgICBzdGFydGluZ1Bvc2l0aW9uOiBwcm9wcy5zdGFydGluZ1Bvc2l0aW9uID8/IGxhbWJkYS5TdGFydGluZ1Bvc2l0aW9uLkxBVEVTVCxcbiAgICAgICAgYmF0Y2hTaXplOiBwcm9wcy5iYXRjaFNpemUsXG4gICAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogcHJvcHMuYmlzZWN0QmF0Y2hPbkVycm9yLFxuICAgICAgICBwYXJhbGxlbGl6YXRpb25GYWN0b3I6IHByb3BzLnBhcmFsbGVsaXphdGlvbkZhY3RvcixcbiAgICAgICAgcmV0cnlBdHRlbXB0czogcHJvcHMucmV0cnlBdHRlbXB0cyxcbiAgICAgICAgbWF4QmF0Y2hpbmdXaW5kb3c6IHByb3BzLm1heEJhdGNoaW5nV2luZG93LFxuICAgICAgICBtYXhSZWNvcmRBZ2U6IHByb3BzLm1heFJlY29yZEFnZSxcbiAgICAgICAgcmVwb3J0QmF0Y2hJdGVtRmFpbHVyZXM6IHByb3BzLnJlcG9ydEJhdGNoSXRlbUZhaWx1cmVzID8/IHRydWUsXG4gICAgICAgIG9uRmFpbHVyZTogcHJvcHMub25GYWlsdXJlLFxuICAgICAgfSksXG4gICAgKTtcbiAgfVxufVxuIl19