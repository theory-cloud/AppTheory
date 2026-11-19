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
exports.CLOUD_FRONT_RECORD_FIELDS = void 0;
exports.httpApiAccessLogFormat = httpApiAccessLogFormat;
exports.restApiAccessLogFormat = restApiAccessLogFormat;
exports.retentionFor = retentionFor;
exports.webSocketApiAccessLogFormat = webSocketApiAccessLogFormat;
exports.accessLogGroupName = accessLogGroupName;
exports.standardLogGroup = standardLogGroup;
exports.enableCloudFrontStandardLogging = enableCloudFrontStandardLogging;
exports.bucketNamingProps = bucketNamingProps;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const logging_1 = require("../logging");
/**
 * The CloudFront standard-logging record fields, in delivery order
 * (contract section 3).
 */
exports.CLOUD_FRONT_RECORD_FIELDS = [
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
function httpApiAccessLogFormat() {
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
function restApiAccessLogFormat() {
    return apigw.AccessLogFormat.custom(JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        resourcePath: "$context.resourcePath",
        status: "$context.status",
        protocol: "$context.protocol",
        responseLength: "$context.responseLength",
        responseLatency: "$context.responseLatency",
        sourceIp: "$context.identity.sourceIp",
    }));
}
/**
 * Resolve the numeric retention to the CloudWatch Logs enum. The context has
 * already validated the value against the accepted set.
 */
function retentionFor(days) {
    return days;
}
/**
 * The API Gateway access-log field names and values for WebSocket APIs
 * (contract section 3, ADV-1311-5). The WebSocket logging-variables list has no
 * protocol, HTTP method or response length, so the shared HTTP field set does
 * not apply.
 */
function webSocketApiAccessLogFormat() {
    return JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        eventType: "$context.eventType",
        routeKey: "$context.routeKey",
        connectionId: "$context.connectionId",
        status: "$context.status",
        integrationLatency: "$context.integrationLatency",
        sourceIp: "$context.identity.sourceIp",
    });
}
/**
 * The access-log group name for a construct-created group.
 *
 * With the standard logging profile the group is a contract log source and
 * takes no naming entry. Under a legacy naming profile the group is consumed
 * like any other resource, so a generated entry sets no name and a pin sets the
 * pinned name.
 */
function accessLogGroupName(context, logical) {
    if (context.standardLogging)
        return context.logGroupName(logical);
    const composed = context.physicalName("log_group", logical);
    return composed.generated ? undefined : composed.name;
}
/**
 * Create a standard-profile log group named from the naming contract.
 */
function standardLogGroup(scope, id, context, logical) {
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
function enableCloudFrontStandardLogging(options) {
    const { scope, id, context, distribution, logical } = options;
    const stackRegion = aws_cdk_lib_1.Stack.of(scope).region;
    if (!aws_cdk_lib_1.Token.isUnresolved(stackRegion) && stackRegion !== "us-east-1") {
        throw new Error(`CloudFront standard logging requires a us-east-1 stack (got ${stackRegion}); a stack outside us-east-1 is out of the v0.1 resource-naming contract`);
    }
    if (aws_cdk_lib_1.Token.isUnresolved(stackRegion)) {
        throw new Error("CloudFront standard logging requires a resolved stack region; an environment-agnostic stack cannot prove the delivery lives in us-east-1 and is out of the v0.1 resource-naming contract");
    }
    if (context.region !== "us-east-1") {
        throw new Error(`CloudFront standard logging requires the naming context region to be us-east-1 (got ${context.region}); a stack outside us-east-1 is out of the v0.1 resource-naming contract`);
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
        outputFormat: options.format ?? logging_1.AppTheoryCloudFrontLogFormat.W3C,
    });
    new logs.CfnDelivery(scope, `${id}Delivery`, {
        deliverySourceName: source.name,
        deliveryDestinationArn: destination.attrArn,
        recordFields: [...exports.CLOUD_FRONT_RECORD_FIELDS],
    });
    return logGroup;
}
/**
 * The bucket-name properties the naming contract requires. A derived profile
 * sets the account-regional namespace and prefix; a legacy pin supplies the
 * full name; a legacy generated entry sets no name so CloudFormation keeps
 * today's name and global namespace.
 */
function bucketNamingProps(context, logical) {
    const composed = context.physicalName("s3_bucket", logical);
    if (composed.generated) {
        return {};
    }
    if (composed.pinned) {
        return { bucketName: composed.name };
    }
    if (composed.bucketNamePrefix === undefined) {
        throw new Error(`AppTheory bucket ${logical} requires an account-regional prefix`);
    }
    return {
        bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
        bucketNamePrefix: composed.bucketNamePrefix,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhbmRhcmQtbG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YW5kYXJkLWxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNkJBLHdEQVlDO0FBS0Qsd0RBY0M7QUFNRCxvQ0FFQztBQVFELGtFQVdDO0FBVUQsZ0RBSUM7QUFLRCw0Q0FVQztBQVdELDBFQThDQztBQVFELDhDQWtCQztBQXZNRCw2Q0FBMkM7QUFDM0Msa0VBQW9EO0FBRXBELDJEQUE2QztBQUM3Qyx1REFBeUM7QUFHekMsd0NBQTBEO0FBRzFEOzs7R0FHRztBQUNVLFFBQUEseUJBQXlCLEdBQUc7SUFDdkMsV0FBVztJQUNYLG1CQUFtQjtJQUNuQixXQUFXO0lBQ1gsYUFBYTtJQUNiLFdBQVc7SUFDWCxVQUFVO0lBQ1YsWUFBWTtJQUNaLG9CQUFvQjtJQUNwQixNQUFNO0NBQ1AsQ0FBQztBQUVGOztHQUVHO0FBQ0gsU0FBZ0Isc0JBQXNCO0lBQ3BDLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNwQixTQUFTLEVBQUUsb0JBQW9CO1FBQy9CLFdBQVcsRUFBRSxzQkFBc0I7UUFDbkMsVUFBVSxFQUFFLHFCQUFxQjtRQUNqQyxRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixjQUFjLEVBQUUseUJBQXlCO1FBQ3pDLGtCQUFrQixFQUFFLDZCQUE2QjtRQUNqRCxRQUFRLEVBQUUsNEJBQTRCO0tBQ3ZDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRDs7R0FFRztBQUNILFNBQWdCLHNCQUFzQjtJQUNwQyxPQUFPLEtBQUssQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUNqQyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ2IsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFB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Q0FBQztRQUM1QyxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixPQUFPLHNDQUFzQyxDQUFDLENBQUM7SUFDckYsQ0FBQztJQUNELE9BQU87UUFDTCxlQUFlLEVBQUUsRUFBRSxDQUFDLGVBQWUsQ0FBQyxnQkFBZ0I7UUFDcEQsZ0JBQWdCLEVBQUUsUUFBUSxDQUFDLGdCQUFnQjtLQUM1QyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi4vbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4uL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKlxuICogVGhlIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyByZWNvcmQgZmllbGRzLCBpbiBkZWxpdmVyeSBvcmRlclxuICogKGNvbnRyYWN0IHNlY3Rpb24gMykuXG4gKi9cbmV4cG9ydCBjb25zdCBDTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTID0gW1xuICBcInRpbWVzdGFtcFwiLFxuICBcIngtZWRnZS1yZXF1ZXN0LWlkXCIsXG4gIFwiY3MtbWV0aG9kXCIsXG4gIFwiY3MtdXJpLXN0ZW1cIixcbiAgXCJzYy1zdGF0dXNcIixcbiAgXCJzYy1ieXRlc1wiLFxuICBcInRpbWUtdGFrZW5cIixcbiAgXCJ4LWVkZ2UtcmVzdWx0LXR5cGVcIixcbiAgXCJjLWlwXCIsXG5dO1xuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIEhUVFAgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgIHNvdXJjZUlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIFJFU1QgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKTogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0IHtcbiAgcmV0dXJuIGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgcmVzb3VyY2VQYXRoOiBcIiRjb250ZXh0LnJlc291cmNlUGF0aFwiLFxuICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICByZXNwb25zZUxhdGVuY3k6IFwiJGNvbnRleHQucmVzcG9uc2VMYXRlbmN5XCIsXG4gICAgICBzb3VyY2VJcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIH0pLFxuICApO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG51bWVyaWMgcmV0ZW50aW9uIHRvIHRoZSBDbG91ZFdhdGNoIExvZ3MgZW51bS4gVGhlIGNvbnRleHQgaGFzXG4gKiBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgdmFsdWUgYWdhaW5zdCB0aGUgYWNjZXB0ZWQgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0ZW50aW9uRm9yKGRheXM6IG51bWJlcik6IGxvZ3MuUmV0ZW50aW9uRGF5cyB7XG4gIHJldHVybiBkYXlzIGFzIGxvZ3MuUmV0ZW50aW9uRGF5cztcbn1cblxuLyoqXG4gKiBUaGUgQVBJIEdhdGV3YXkgYWNjZXNzLWxvZyBmaWVsZCBuYW1lcyBhbmQgdmFsdWVzIGZvciBXZWJTb2NrZXQgQVBJc1xuICogKGNvbnRyYWN0IHNlY3Rpb24gMywgQURWLTEzMTEtNSkuIFRoZSBXZWJTb2NrZXQgbG9nZ2luZy12YXJpYWJsZXMgbGlzdCBoYXMgbm9cbiAqIHByb3RvY29sLCBIVFRQIG1ldGhvZCBvciByZXNwb25zZSBsZW5ndGgsIHNvIHRoZSBzaGFyZWQgSFRUUCBmaWVsZCBzZXQgZG9lc1xuICogbm90IGFwcGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgZXZlbnRUeXBlOiBcIiRjb250ZXh0LmV2ZW50VHlwZVwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgY29ubmVjdGlvbklkOiBcIiRjb250ZXh0LmNvbm5lY3Rpb25JZFwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgc291cmNlSXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgfSk7XG59XG5cbi8qKlxuICogVGhlIGFjY2Vzcy1sb2cgZ3JvdXAgbmFtZSBmb3IgYSBjb25zdHJ1Y3QtY3JlYXRlZCBncm91cC5cbiAqXG4gKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgdGhlIGdyb3VwIGlzIGEgY29udHJhY3QgbG9nIHNvdXJjZSBhbmRcbiAqIHRha2VzIG5vIG5hbWluZyBlbnRyeS4gVW5kZXIgYSBsZWdhY3kgbmFtaW5nIHByb2ZpbGUgdGhlIGdyb3VwIGlzIGNvbnN1bWVkXG4gKiBsaWtlIGFueSBvdGhlciByZXNvdXJjZSwgc28gYSBnZW5lcmF0ZWQgZW50cnkgc2V0cyBubyBuYW1lIGFuZCBhIHBpbiBzZXRzIHRoZVxuICogcGlubmVkIG5hbWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhY2Nlc3NMb2dHcm91cE5hbWUoY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCwgbG9naWNhbDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGNvbnRleHQuc3RhbmRhcmRMb2dnaW5nKSByZXR1cm4gY29udGV4dC5sb2dHcm91cE5hbWUobG9naWNhbCk7XG4gIGNvbnN0IGNvbXBvc2VkID0gY29udGV4dC5waHlzaWNhbE5hbWUoXCJsb2dfZ3JvdXBcIiwgbG9naWNhbCk7XG4gIHJldHVybiBjb21wb3NlZC5nZW5lcmF0ZWQgPyB1bmRlZmluZWQgOiBjb21wb3NlZC5uYW1lO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3VwIG5hbWVkIGZyb20gdGhlIG5hbWluZyBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YW5kYXJkTG9nR3JvdXAoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGlkOiBzdHJpbmcsXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gIGxvZ2ljYWw6IHN0cmluZyxcbik6IGxvZ3MuTG9nR3JvdXAge1xuICByZXR1cm4gbmV3IGxvZ3MuTG9nR3JvdXAoc2NvcGUsIGlkLCB7XG4gICAgbG9nR3JvdXBOYW1lOiBjb250ZXh0LmxvZ0dyb3VwTmFtZShsb2dpY2FsKSxcbiAgICByZXRlbnRpb246IHJldGVudGlvbkZvcihjb250ZXh0LnJldGVudGlvbkRheXMpLFxuICB9KTtcbn1cblxuLyoqXG4gKiBXaXJlIENsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnk6XG4gKiBhIGRlbGl2ZXJ5IHNvdXJjZSwgYSBkZWxpdmVyeSBkZXN0aW5hdGlvbiBvdmVyIHRoZSBsb2cgZ3JvdXAsIGFuZCBhIGRlbGl2ZXJ5XG4gKiBjYXJyeWluZyB0aGUgY29udHJhY3QncyByZWNvcmQgZmllbGRzLlxuICpcbiAqIFRoZSBjb250cmFjdCByZXF1aXJlcyB0aGVzZSByZXNvdXJjZXMgaW4gYHVzLWVhc3QtMWA7IGEgc3RhY2sgZWxzZXdoZXJlIGlzXG4gKiBvdXQgb2YgdjAuMSwgc28gc3ludGhlc2lzIGZhaWxzIGluc3RlYWQgb2YgY3JlYXRpbmcgYSBkZWxpdmVyeSB0aGF0IGNhbm5vdFxuICogcmVjZWl2ZSBDbG91ZEZyb250IGxvZ3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nKG9wdGlvbnM6IHtcbiAgcmVhZG9ubHkgc2NvcGU6IENvbnN0cnVjdDtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcbiAgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LklEaXN0cmlidXRpb247XG4gIHJlYWRvbmx5IGxvZ2ljYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgZm9ybWF0PzogQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdDtcbn0pOiBsb2dzLkxvZ0dyb3VwIHtcbiAgY29uc3QgeyBzY29wZSwgaWQsIGNvbnRleHQsIGRpc3RyaWJ1dGlvbiwgbG9naWNhbCB9ID0gb3B0aW9ucztcbiAgY29uc3Qgc3RhY2tSZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChzdGFja1JlZ2lvbikgJiYgc3RhY2tSZWdpb24gIT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2xvdWRGcm9udCBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgdXMtZWFzdC0xIHN0YWNrIChnb3QgJHtzdGFja1JlZ2lvbn0pOyBhIHN0YWNrIG91dHNpZGUgdXMtZWFzdC0xIGlzIG91dCBvZiB0aGUgdjAuMSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3RgLFxuICAgICk7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChzdGFja1JlZ2lvbikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkNsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIHJlc29sdmVkIHN0YWNrIHJlZ2lvbjsgYW4gZW52aXJvbm1lbnQtYWdub3N0aWMgc3RhY2sgY2Fubm90IHByb3ZlIHRoZSBkZWxpdmVyeSBsaXZlcyBpbiB1cy1lYXN0LTEgYW5kIGlzIG91dCBvZiB0aGUgdjAuMSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChjb250ZXh0LnJlZ2lvbiAhPT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgdGhlIG5hbWluZyBjb250ZXh0IHJlZ2lvbiB0byBiZSB1cy1lYXN0LTEgKGdvdCAke2NvbnRleHQucmVnaW9ufSk7IGEgc3RhY2sgb3V0c2lkZSB1cy1lYXN0LTEgaXMgb3V0IG9mIHRoZSB2MC4xIHJlc291cmNlLW5hbWluZyBjb250cmFjdGAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBsb2dHcm91cCA9IHN0YW5kYXJkTG9nR3JvdXAoc2NvcGUsIGAke2lkfUxvZ0dyb3VwYCwgY29udGV4dCwgbG9naWNhbCk7XG5cbiAgY29uc3Qgc291cmNlID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnlTb3VyY2Uoc2NvcGUsIGAke2lkfURlbGl2ZXJ5U291cmNlYCwge1xuICAgIG5hbWU6IGNvbnRleHQucGh5c2ljYWxOYW1lKFwibG9nX2RlbGl2ZXJ5X3NvdXJjZVwiLCBsb2dpY2FsKS5uYW1lIGFzIHN0cmluZyxcbiAgICBsb2dUeXBlOiBcIkFDQ0VTU19MT0dTXCIsXG4gICAgcmVzb3VyY2VBcm46IGRpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Bcm4sXG4gIH0pO1xuXG4gIGNvbnN0IGRlc3RpbmF0aW9uID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnlEZXN0aW5hdGlvbihzY29wZSwgYCR7aWR9RGVsaXZlcnlEZXN0aW5hdGlvbmAsIHtcbiAgICBuYW1lOiBjb250ZXh0LnBoeXNpY2FsTmFtZShcImxvZ19kZWxpdmVyeV9kZXN0aW5hdGlvblwiLCBsb2dpY2FsKS5uYW1lIGFzIHN0cmluZyxcbiAgICBkZXN0aW5hdGlvblJlc291cmNlQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICBvdXRwdXRGb3JtYXQ6IG9wdGlvbnMuZm9ybWF0ID8/IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuVzNDLFxuICB9KTtcblxuICBuZXcgbG9ncy5DZm5EZWxpdmVyeShzY29wZSwgYCR7aWR9RGVsaXZlcnlgLCB7XG4gICAgZGVsaXZlcnlTb3VyY2VOYW1lOiBzb3VyY2UubmFtZSxcbiAgICBkZWxpdmVyeURlc3RpbmF0aW9uQXJuOiBkZXN0aW5hdGlvbi5hdHRyQXJuLFxuICAgIHJlY29yZEZpZWxkczogWy4uLkNMT1VEX0ZST05UX1JFQ09SRF9GSUVMRFNdLFxuICB9KTtcblxuICByZXR1cm4gbG9nR3JvdXA7XG59XG5cbi8qKlxuICogVGhlIGJ1Y2tldC1uYW1lIHByb3BlcnRpZXMgdGhlIG5hbWluZyBjb250cmFjdCByZXF1aXJlcy4gQSBkZXJpdmVkIHByb2ZpbGVcbiAqIHNldHMgdGhlIGFjY291bnQtcmVnaW9uYWwgbmFtZXNwYWNlIGFuZCBwcmVmaXg7IGEgbGVnYWN5IHBpbiBzdXBwbGllcyB0aGVcbiAqIGZ1bGwgbmFtZTsgYSBsZWdhY3kgZ2VuZXJhdGVkIGVudHJ5IHNldHMgbm8gbmFtZSBzbyBDbG91ZEZvcm1hdGlvbiBrZWVwc1xuICogdG9kYXkncyBuYW1lIGFuZCBnbG9iYWwgbmFtZXNwYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVja2V0TmFtaW5nUHJvcHMoXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gIGxvZ2ljYWw6IHN0cmluZyxcbik6IHsgYnVja2V0TmFtZT86IHN0cmluZzsgYnVja2V0TmFtZXNwYWNlPzogczMuQnVja2V0TmFtZXNwYWNlOyBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nIH0ge1xuICBjb25zdCBjb21wb3NlZCA9IGNvbnRleHQucGh5c2ljYWxOYW1lKFwiczNfYnVja2V0XCIsIGxvZ2ljYWwpO1xuICBpZiAoY29tcG9zZWQuZ2VuZXJhdGVkKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGlmIChjb21wb3NlZC5waW5uZWQpIHtcbiAgICByZXR1cm4geyBidWNrZXROYW1lOiBjb21wb3NlZC5uYW1lIH07XG4gIH1cbiAgaWYgKGNvbXBvc2VkLmJ1Y2tldE5hbWVQcmVmaXggPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5IGJ1Y2tldCAke2xvZ2ljYWx9IHJlcXVpcmVzIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4YCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBidWNrZXROYW1lc3BhY2U6IHMzLkJ1Y2tldE5hbWVzcGFjZS5BQ0NPVU5UX1JFR0lPTkFMLFxuICAgIGJ1Y2tldE5hbWVQcmVmaXg6IGNvbXBvc2VkLmJ1Y2tldE5hbWVQcmVmaXgsXG4gIH07XG59XG4iXX0=