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
    const format = options.format ?? logging_1.AppTheoryCloudFrontLogFormat.JSON;
    if (format !== logging_1.AppTheoryCloudFrontLogFormat.JSON) {
        throw new Error(`CloudFront standard logging cannot use output format ${JSON.stringify(format)} for a CloudWatch Logs delivery destination: the resource-naming contract section 3 settles CloudFront ACCESS_LOGS to CloudWatch Logs on "json" (DescribeConfigurationTemplates allows only "plain" and "json", and "w3c" is S3-only). Use AppTheoryCloudFrontLogFormat.JSON.`);
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
        outputFormat: format,
    });
    const delivery = new logs.CfnDelivery(scope, `${id}Delivery`, {
        deliverySourceName: source.name,
        deliveryDestinationArn: destination.attrArn,
        recordFields: [...exports.CLOUD_FRONT_RECORD_FIELDS],
    });
    // The delivery source is named by a literal string, so CloudFormation sees no
    // edge from the delivery to the source; the source waits on the distribution
    // ARN, so an unordered delivery can be created before its source exists.
    delivery.node.addDependency(source);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhbmRhcmQtbG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YW5kYXJkLWxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNkJBLHdEQVlDO0FBS0Qsd0RBY0M7QUFNRCxvQ0FFQztBQVFELGtFQVdDO0FBS0QsNENBVUM7QUFXRCwwRUF3REM7QUFRRCw4Q0FrQkM7QUFuTUQsNkNBQTJDO0FBQzNDLGtFQUFvRDtBQUVwRCwyREFBNkM7QUFDN0MsdURBQXlDO0FBR3pDLHdDQUEwRDtBQUcxRDs7O0dBR0c7QUFDVSxRQUFBLHlCQUF5QixHQUFHO0lBQ3ZDLFdBQVc7SUFDWCxtQkFBbUI7SUFDbkIsV0FBVztJQUNYLGFBQWE7SUFDYixXQUFXO0lBQ1gsVUFBVTtJQUNWLFlBQVk7SUFDWixvQkFBb0I7SUFDcEIsTUFBTTtDQUNQLENBQUM7QUFFRjs7R0FFRztBQUNILFNBQWdCLHNCQUFzQjtJQUNwQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7UUFDakQsUUFBUSxFQUFFLDRCQUE0QjtLQUN2QyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixzQkFBc0I7SUFDcEMsT0FBTyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNiLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxVQUFVLEVBQUUscUJBQXFCO1FBQ2pDLFlB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S0FBSyxDQUFDLG9CQUFvQixPQUFPLHNDQUFzQyxDQUFDLENBQUM7SUFDckYsQ0FBQztJQUNELE9BQU87UUFDTCxlQUFlLEVBQUUsRUFBRSxDQUFDLGVBQWUsQ0FBQyxnQkFBZ0I7UUFDcEQsZ0JBQWdCLEVBQUUsUUFBUSxDQUFDLGdCQUFnQjtLQUM1QyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi4vbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4uL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKlxuICogVGhlIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyByZWNvcmQgZmllbGRzLCBpbiBkZWxpdmVyeSBvcmRlclxuICogKGNvbnRyYWN0IHNlY3Rpb24gMykuXG4gKi9cbmV4cG9ydCBjb25zdCBDTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTID0gW1xuICBcInRpbWVzdGFtcFwiLFxuICBcIngtZWRnZS1yZXF1ZXN0LWlkXCIsXG4gIFwiY3MtbWV0aG9kXCIsXG4gIFwiY3MtdXJpLXN0ZW1cIixcbiAgXCJzYy1zdGF0dXNcIixcbiAgXCJzYy1ieXRlc1wiLFxuICBcInRpbWUtdGFrZW5cIixcbiAgXCJ4LWVkZ2UtcmVzdWx0LXR5cGVcIixcbiAgXCJjLWlwXCIsXG5dO1xuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIEhUVFAgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgIHNvdXJjZUlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIFJFU1QgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKTogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0IHtcbiAgcmV0dXJuIGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgcmVzb3VyY2VQYXRoOiBcIiRjb250ZXh0LnJlc291cmNlUGF0aFwiLFxuICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICByZXNwb25zZUxhdGVuY3k6IFwiJGNvbnRleHQucmVzcG9uc2VMYXRlbmN5XCIsXG4gICAgICBzb3VyY2VJcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIH0pLFxuICApO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG51bWVyaWMgcmV0ZW50aW9uIHRvIHRoZSBDbG91ZFdhdGNoIExvZ3MgZW51bS4gVGhlIGNvbnRleHQgaGFzXG4gKiBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgdmFsdWUgYWdhaW5zdCB0aGUgYWNjZXB0ZWQgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0ZW50aW9uRm9yKGRheXM6IG51bWJlcik6IGxvZ3MuUmV0ZW50aW9uRGF5cyB7XG4gIHJldHVybiBkYXlzIGFzIGxvZ3MuUmV0ZW50aW9uRGF5cztcbn1cblxuLyoqXG4gKiBUaGUgQVBJIEdhdGV3YXkgYWNjZXNzLWxvZyBmaWVsZCBuYW1lcyBhbmQgdmFsdWVzIGZvciBXZWJTb2NrZXQgQVBJc1xuICogKGNvbnRyYWN0IHNlY3Rpb24gMywgQURWLTEzMTEtNSkuIFRoZSBXZWJTb2NrZXQgbG9nZ2luZy12YXJpYWJsZXMgbGlzdCBoYXMgbm9cbiAqIHByb3RvY29sLCBIVFRQIG1ldGhvZCBvciByZXNwb25zZSBsZW5ndGgsIHNvIHRoZSBzaGFyZWQgSFRUUCBmaWVsZCBzZXQgZG9lc1xuICogbm90IGFwcGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgZXZlbnRUeXBlOiBcIiRjb250ZXh0LmV2ZW50VHlwZVwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgY29ubmVjdGlvbklkOiBcIiRjb250ZXh0LmNvbm5lY3Rpb25JZFwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgc291cmNlSXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgfSk7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgc3RhbmRhcmQtcHJvZmlsZSBsb2cgZ3JvdXAgbmFtZWQgZnJvbSB0aGUgbmFtaW5nIGNvbnRyYWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhbmRhcmRMb2dHcm91cChcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgaWQ6IHN0cmluZyxcbiAgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgbG9naWNhbDogc3RyaW5nLFxuKTogbG9ncy5Mb2dHcm91cCB7XG4gIHJldHVybiBuZXcgbG9ncy5Mb2dHcm91cChzY29wZSwgaWQsIHtcbiAgICBsb2dHcm91cE5hbWU6IGNvbnRleHQubG9nR3JvdXBOYW1lKGxvZ2ljYWwpLFxuICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKGNvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gIH0pO1xufVxuXG4vKipcbiAqIFdpcmUgQ2xvdWRGcm9udCBzdGFuZGFyZCBsb2dnaW5nIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeTpcbiAqIGEgZGVsaXZlcnkgc291cmNlLCBhIGRlbGl2ZXJ5IGRlc3RpbmF0aW9uIG92ZXIgdGhlIGxvZyBncm91cCwgYW5kIGEgZGVsaXZlcnlcbiAqIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzIHJlY29yZCBmaWVsZHMuXG4gKlxuICogVGhlIGNvbnRyYWN0IHJlcXVpcmVzIHRoZXNlIHJlc291cmNlcyBpbiBgdXMtZWFzdC0xYDsgYSBzdGFjayBlbHNld2hlcmUgaXNcbiAqIG91dCBvZiB2MC4xLCBzbyBzeW50aGVzaXMgZmFpbHMgaW5zdGVhZCBvZiBjcmVhdGluZyBhIGRlbGl2ZXJ5IHRoYXQgY2Fubm90XG4gKiByZWNlaXZlIENsb3VkRnJvbnQgbG9ncy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcob3B0aW9uczoge1xuICByZWFkb25seSBzY29wZTogQ29uc3RydWN0O1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuICByZWFkb25seSBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuICByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuSURpc3RyaWJ1dGlvbjtcbiAgcmVhZG9ubHkgbG9naWNhbDogc3RyaW5nO1xuICByZWFkb25seSBmb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xufSk6IGxvZ3MuTG9nR3JvdXAge1xuICBjb25zdCB7IHNjb3BlLCBpZCwgY29udGV4dCwgZGlzdHJpYnV0aW9uLCBsb2dpY2FsIH0gPSBvcHRpb25zO1xuICBjb25zdCBzdGFja1JlZ2lvbiA9IFN0YWNrLm9mKHNjb3BlKS5yZWdpb247XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHN0YWNrUmVnaW9uKSAmJiBzdGFja1JlZ2lvbiAhPT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSB1cy1lYXN0LTEgc3RhY2sgKGdvdCAke3N0YWNrUmVnaW9ufSk7IGEgc3RhY2sgb3V0c2lkZSB1cy1lYXN0LTEgaXMgb3V0IG9mIHRoZSB2MC4xIHJlc291cmNlLW5hbWluZyBjb250cmFjdGAsXG4gICAgKTtcbiAgfVxuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHN0YWNrUmVnaW9uKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQ2xvdWRGcm9udCBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgcmVzb2x2ZWQgc3RhY2sgcmVnaW9uOyBhbiBlbnZpcm9ubWVudC1hZ25vc3RpYyBzdGFjayBjYW5ub3QgcHJvdmUgdGhlIGRlbGl2ZXJ5IGxpdmVzIGluIHVzLWVhc3QtMSBhbmQgaXMgb3V0IG9mIHRoZSB2MC4xIHJlc291cmNlLW5hbWluZyBjb250cmFjdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGNvbnRleHQucmVnaW9uICE9PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyB0aGUgbmFtaW5nIGNvbnRleHQgcmVnaW9uIHRvIGJlIHVzLWVhc3QtMSAoZ290ICR7Y29udGV4dC5yZWdpb259KTsgYSBzdGFjayBvdXRzaWRlIHVzLWVhc3QtMSBpcyBvdXQgb2YgdGhlIHYwLjEgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGZvcm1hdCA9IG9wdGlvbnMuZm9ybWF0ID8/IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTjtcbiAgaWYgKGZvcm1hdCAhPT0gQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdC5KU09OKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyBjYW5ub3QgdXNlIG91dHB1dCBmb3JtYXQgJHtKU09OLnN0cmluZ2lmeShmb3JtYXQpfSBmb3IgYSBDbG91ZFdhdGNoIExvZ3MgZGVsaXZlcnkgZGVzdGluYXRpb246IHRoZSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3Qgc2VjdGlvbiAzIHNldHRsZXMgQ2xvdWRGcm9udCBBQ0NFU1NfTE9HUyB0byBDbG91ZFdhdGNoIExvZ3Mgb24gXCJqc29uXCIgKERlc2NyaWJlQ29uZmlndXJhdGlvblRlbXBsYXRlcyBhbGxvd3Mgb25seSBcInBsYWluXCIgYW5kIFwianNvblwiLCBhbmQgXCJ3M2NcIiBpcyBTMy1vbmx5KS4gVXNlIEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTi5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbG9nR3JvdXAgPSBzdGFuZGFyZExvZ0dyb3VwKHNjb3BlLCBgJHtpZH1Mb2dHcm91cGAsIGNvbnRleHQsIGxvZ2ljYWwpO1xuXG4gIGNvbnN0IHNvdXJjZSA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5U291cmNlKHNjb3BlLCBgJHtpZH1EZWxpdmVyeVNvdXJjZWAsIHtcbiAgICBuYW1lOiBjb250ZXh0LnBoeXNpY2FsTmFtZShcImxvZ19kZWxpdmVyeV9zb3VyY2VcIiwgbG9naWNhbCkubmFtZSBhcyBzdHJpbmcsXG4gICAgbG9nVHlwZTogXCJBQ0NFU1NfTE9HU1wiLFxuICAgIHJlc291cmNlQXJuOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uQXJuLFxuICB9KTtcblxuICBjb25zdCBkZXN0aW5hdGlvbiA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5RGVzdGluYXRpb24oc2NvcGUsIGAke2lkfURlbGl2ZXJ5RGVzdGluYXRpb25gLCB7XG4gICAgbmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJsb2dfZGVsaXZlcnlfZGVzdGluYXRpb25cIiwgbG9naWNhbCkubmFtZSBhcyBzdHJpbmcsXG4gICAgZGVzdGluYXRpb25SZXNvdXJjZUFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgb3V0cHV0Rm9ybWF0OiBmb3JtYXQsXG4gIH0pO1xuXG4gIGNvbnN0IGRlbGl2ZXJ5ID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnkoc2NvcGUsIGAke2lkfURlbGl2ZXJ5YCwge1xuICAgIGRlbGl2ZXJ5U291cmNlTmFtZTogc291cmNlLm5hbWUsXG4gICAgZGVsaXZlcnlEZXN0aW5hdGlvbkFybjogZGVzdGluYXRpb24uYXR0ckFybixcbiAgICByZWNvcmRGaWVsZHM6IFsuLi5DTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTXSxcbiAgfSk7XG4gIC8vIFRoZSBkZWxpdmVyeSBzb3VyY2UgaXMgbmFtZWQgYnkgYSBsaXRlcmFsIHN0cmluZywgc28gQ2xvdWRGb3JtYXRpb24gc2VlcyBub1xuICAvLyBlZGdlIGZyb20gdGhlIGRlbGl2ZXJ5IHRvIHRoZSBzb3VyY2U7IHRoZSBzb3VyY2Ugd2FpdHMgb24gdGhlIGRpc3RyaWJ1dGlvblxuICAvLyBBUk4sIHNvIGFuIHVub3JkZXJlZCBkZWxpdmVyeSBjYW4gYmUgY3JlYXRlZCBiZWZvcmUgaXRzIHNvdXJjZSBleGlzdHMuXG4gIGRlbGl2ZXJ5Lm5vZGUuYWRkRGVwZW5kZW5jeShzb3VyY2UpO1xuXG4gIHJldHVybiBsb2dHcm91cDtcbn1cblxuLyoqXG4gKiBUaGUgYnVja2V0LW5hbWUgcHJvcGVydGllcyB0aGUgbmFtaW5nIGNvbnRyYWN0IHJlcXVpcmVzLiBBIGRlcml2ZWQgcHJvZmlsZVxuICogc2V0cyB0aGUgYWNjb3VudC1yZWdpb25hbCBuYW1lc3BhY2UgYW5kIHByZWZpeDsgYSBsZWdhY3kgcGluIHN1cHBsaWVzIHRoZVxuICogZnVsbCBuYW1lOyBhIGxlZ2FjeSBnZW5lcmF0ZWQgZW50cnkgc2V0cyBubyBuYW1lIHNvIENsb3VkRm9ybWF0aW9uIGtlZXBzXG4gKiB0b2RheSdzIG5hbWUgYW5kIGdsb2JhbCBuYW1lc3BhY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWNrZXROYW1pbmdQcm9wcyhcbiAgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgbG9naWNhbDogc3RyaW5nLFxuKTogeyBidWNrZXROYW1lPzogc3RyaW5nOyBidWNrZXROYW1lc3BhY2U/OiBzMy5CdWNrZXROYW1lc3BhY2U7IGJ1Y2tldE5hbWVQcmVmaXg/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNvbXBvc2VkID0gY29udGV4dC5waHlzaWNhbE5hbWUoXCJzM19idWNrZXRcIiwgbG9naWNhbCk7XG4gIGlmIChjb21wb3NlZC5nZW5lcmF0ZWQpIHtcbiAgICByZXR1cm4ge307XG4gIH1cbiAgaWYgKGNvbXBvc2VkLnBpbm5lZCkge1xuICAgIHJldHVybiB7IGJ1Y2tldE5hbWU6IGNvbXBvc2VkLm5hbWUgfTtcbiAgfVxuICBpZiAoY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnkgYnVja2V0ICR7bG9naWNhbH0gcmVxdWlyZXMgYW4gYWNjb3VudC1yZWdpb25hbCBwcmVmaXhgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGJ1Y2tldE5hbWVzcGFjZTogczMuQnVja2V0TmFtZXNwYWNlLkFDQ09VTlRfUkVHSU9OQUwsXG4gICAgYnVja2V0TmFtZVByZWZpeDogY29tcG9zZWQuYnVja2V0TmFtZVByZWZpeCxcbiAgfTtcbn1cbiJdfQ==