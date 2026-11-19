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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhbmRhcmQtbG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YW5kYXJkLWxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNkJBLHdEQVlDO0FBS0Qsd0RBY0M7QUFNRCxvQ0FFQztBQVFELGtFQVdDO0FBS0QsNENBVUM7QUFXRCwwRUE4Q0M7QUFRRCw4Q0FrQkM7QUF6TEQsNkNBQTJDO0FBQzNDLGtFQUFvRDtBQUVwRCwyREFBNkM7QUFDN0MsdURBQXlDO0FBR3pDLHdDQUEwRDtBQUcxRDs7O0dBR0c7QUFDVSxRQUFBLHlCQUF5QixHQUFHO0lBQ3ZDLFdBQVc7SUFDWCxtQkFBbUI7SUFDbkIsV0FBVztJQUNYLGFBQWE7SUFDYixXQUFXO0lBQ1gsVUFBVTtJQUNWLFlBQVk7SUFDWixvQkFBb0I7SUFDcEIsTUFBTTtDQUNQLENBQUM7QUFFRjs7R0FFRztBQUNILFNBQWdCLHNCQUFzQjtJQUNwQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7UUFDakQsUUFBUSxFQUFFLDRCQUE0QjtLQUN2QyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixzQkFBc0I7SUFDcEMsT0FBTyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNiLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxVQUFVLEVBQUUscUJBQXFCO1FBQ2pDLFlB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QUM1QyxZQUFZLEVBQUUsT0FBTyxDQUFDLE1BQU0sSUFBSSxzQ0FBNEIsQ0FBQyxHQUFHO0tBQ2pFLENBQUMsQ0FBQztJQUVILElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLFVBQVUsRUFBRTtRQUMzQyxrQkFBa0IsRUFBRSxNQUFNLENBQUMsSUFBSTtRQUMvQixzQkFBc0IsRUFBRSxXQUFXLENBQUMsT0FBTztRQUMzQyxZQUFZLEVBQUUsQ0FBQyxHQUFHLGlDQUF5QixDQUFDO0tBQzdDLENBQUMsQ0FBQztJQUVILE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQWdCLGlCQUFpQixDQUMvQixPQUErQixFQUMvQixPQUFlO0lBRWYsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFlBQVksQ0FBQyxXQUFXLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDNUQsSUFBSSxRQUFRLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDdkIsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDO0lBQ0QsSUFBSSxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDcEIsT0FBTyxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDdkMsQ0FBQztJQUNELElBQUksUUFBUSxDQUFDLGdCQUFnQixLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLE9BQU8sc0NBQXNDLENBQUMsQ0FBQztJQUNyRixDQUFDO0lBQ0QsT0FBTztRQUNMLGVBQWUsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLGdCQUFnQjtRQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO0tBQzVDLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdCB9IGZyb20gXCIuLi9sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi4vbmFtaW5nLWNvbnRleHRcIjtcblxuLyoqXG4gKiBUaGUgQ2xvdWRGcm9udCBzdGFuZGFyZC1sb2dnaW5nIHJlY29yZCBmaWVsZHMsIGluIGRlbGl2ZXJ5IG9yZGVyXG4gKiAoY29udHJhY3Qgc2VjdGlvbiAzKS5cbiAqL1xuZXhwb3J0IGNvbnN0IENMT1VEX0ZST05UX1JFQ09SRF9GSUVMRFMgPSBbXG4gIFwidGltZXN0YW1wXCIsXG4gIFwieC1lZGdlLXJlcXVlc3QtaWRcIixcbiAgXCJjcy1tZXRob2RcIixcbiAgXCJjcy11cmktc3RlbVwiLFxuICBcInNjLXN0YXR1c1wiLFxuICBcInNjLWJ5dGVzXCIsXG4gIFwidGltZS10YWtlblwiLFxuICBcIngtZWRnZS1yZXN1bHQtdHlwZVwiLFxuICBcImMtaXBcIixcbl07XG5cbi8qKlxuICogVGhlIEFQSSBHYXRld2F5IGFjY2Vzcy1sb2cgZmllbGQgbmFtZXMgYW5kIHZhbHVlcyBmb3IgSFRUUCBBUElzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgc291cmNlSXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgfSk7XG59XG5cbi8qKlxuICogVGhlIEFQSSBHYXRld2F5IGFjY2Vzcy1sb2cgZmllbGQgbmFtZXMgYW5kIHZhbHVlcyBmb3IgUkVTVCBBUElzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzdEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpOiBhcGlndy5BY2Nlc3NMb2dGb3JtYXQge1xuICByZXR1cm4gYXBpZ3cuQWNjZXNzTG9nRm9ybWF0LmN1c3RvbShcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICByZXNvdXJjZVBhdGg6IFwiJGNvbnRleHQucmVzb3VyY2VQYXRoXCIsXG4gICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICAgIHJlc3BvbnNlTGF0ZW5jeTogXCIkY29udGV4dC5yZXNwb25zZUxhdGVuY3lcIixcbiAgICAgIHNvdXJjZUlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgfSksXG4gICk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgbnVtZXJpYyByZXRlbnRpb24gdG8gdGhlIENsb3VkV2F0Y2ggTG9ncyBlbnVtLiBUaGUgY29udGV4dCBoYXNcbiAqIGFscmVhZHkgdmFsaWRhdGVkIHRoZSB2YWx1ZSBhZ2FpbnN0IHRoZSBhY2NlcHRlZCBzZXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXRlbnRpb25Gb3IoZGF5czogbnVtYmVyKTogbG9ncy5SZXRlbnRpb25EYXlzIHtcbiAgcmV0dXJuIGRheXMgYXMgbG9ncy5SZXRlbnRpb25EYXlzO1xufVxuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIFdlYlNvY2tldCBBUElzXG4gKiAoY29udHJhY3Qgc2VjdGlvbiAzLCBBRFYtMTMxMS01KS4gVGhlIFdlYlNvY2tldCBsb2dnaW5nLXZhcmlhYmxlcyBsaXN0IGhhcyBub1xuICogcHJvdG9jb2wsIEhUVFAgbWV0aG9kIG9yIHJlc3BvbnNlIGxlbmd0aCwgc28gdGhlIHNoYXJlZCBIVFRQIGZpZWxkIHNldCBkb2VzXG4gKiBub3QgYXBwbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3ZWJTb2NrZXRBcGlBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBldmVudFR5cGU6IFwiJGNvbnRleHQuZXZlbnRUeXBlXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBjb25uZWN0aW9uSWQ6IFwiJGNvbnRleHQuY29ubmVjdGlvbklkXCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICBzb3VyY2VJcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICB9KTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cCBuYW1lZCBmcm9tIHRoZSBuYW1pbmcgY29udHJhY3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFuZGFyZExvZ0dyb3VwKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBpZDogc3RyaW5nLFxuICBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICBsb2dpY2FsOiBzdHJpbmcsXG4pOiBsb2dzLkxvZ0dyb3VwIHtcbiAgcmV0dXJuIG5ldyBsb2dzLkxvZ0dyb3VwKHNjb3BlLCBpZCwge1xuICAgIGxvZ0dyb3VwTmFtZTogY29udGV4dC5sb2dHcm91cE5hbWUobG9naWNhbCksXG4gICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IoY29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgfSk7XG59XG5cbi8qKlxuICogV2lyZSBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgdGhyb3VnaCBDbG91ZFdhdGNoIExvZ3MgdmVuZGVkIGRlbGl2ZXJ5OlxuICogYSBkZWxpdmVyeSBzb3VyY2UsIGEgZGVsaXZlcnkgZGVzdGluYXRpb24gb3ZlciB0aGUgbG9nIGdyb3VwLCBhbmQgYSBkZWxpdmVyeVxuICogY2FycnlpbmcgdGhlIGNvbnRyYWN0J3MgcmVjb3JkIGZpZWxkcy5cbiAqXG4gKiBUaGUgY29udHJhY3QgcmVxdWlyZXMgdGhlc2UgcmVzb3VyY2VzIGluIGB1cy1lYXN0LTFgOyBhIHN0YWNrIGVsc2V3aGVyZSBpc1xuICogb3V0IG9mIHYwLjEsIHNvIHN5bnRoZXNpcyBmYWlscyBpbnN0ZWFkIG9mIGNyZWF0aW5nIGEgZGVsaXZlcnkgdGhhdCBjYW5ub3RcbiAqIHJlY2VpdmUgQ2xvdWRGcm9udCBsb2dzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyhvcHRpb25zOiB7XG4gIHJlYWRvbmx5IHNjb3BlOiBDb25zdHJ1Y3Q7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG4gIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5JRGlzdHJpYnV0aW9uO1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGZvcm1hdD86IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQ7XG59KTogbG9ncy5Mb2dHcm91cCB7XG4gIGNvbnN0IHsgc2NvcGUsIGlkLCBjb250ZXh0LCBkaXN0cmlidXRpb24sIGxvZ2ljYWwgfSA9IG9wdGlvbnM7XG4gIGNvbnN0IHN0YWNrUmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQoc3RhY2tSZWdpb24pICYmIHN0YWNrUmVnaW9uICE9PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIHVzLWVhc3QtMSBzdGFjayAoZ290ICR7c3RhY2tSZWdpb259KTsgYSBzdGFjayBvdXRzaWRlIHVzLWVhc3QtMSBpcyBvdXQgb2YgdGhlIHYwLjEgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0YCxcbiAgICApO1xuICB9XG4gIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQoc3RhY2tSZWdpb24pKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSByZXNvbHZlZCBzdGFjayByZWdpb247IGFuIGVudmlyb25tZW50LWFnbm9zdGljIHN0YWNrIGNhbm5vdCBwcm92ZSB0aGUgZGVsaXZlcnkgbGl2ZXMgaW4gdXMtZWFzdC0xIGFuZCBpcyBvdXQgb2YgdGhlIHYwLjEgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoY29udGV4dC5yZWdpb24gIT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2xvdWRGcm9udCBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIHRoZSBuYW1pbmcgY29udGV4dCByZWdpb24gdG8gYmUgdXMtZWFzdC0xIChnb3QgJHtjb250ZXh0LnJlZ2lvbn0pOyBhIHN0YWNrIG91dHNpZGUgdXMtZWFzdC0xIGlzIG91dCBvZiB0aGUgdjAuMSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3RgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbG9nR3JvdXAgPSBzdGFuZGFyZExvZ0dyb3VwKHNjb3BlLCBgJHtpZH1Mb2dHcm91cGAsIGNvbnRleHQsIGxvZ2ljYWwpO1xuXG4gIGNvbnN0IHNvdXJjZSA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5U291cmNlKHNjb3BlLCBgJHtpZH1EZWxpdmVyeVNvdXJjZWAsIHtcbiAgICBuYW1lOiBjb250ZXh0LnBoeXNpY2FsTmFtZShcImxvZ19kZWxpdmVyeV9zb3VyY2VcIiwgbG9naWNhbCkubmFtZSBhcyBzdHJpbmcsXG4gICAgbG9nVHlwZTogXCJBQ0NFU1NfTE9HU1wiLFxuICAgIHJlc291cmNlQXJuOiBkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uQXJuLFxuICB9KTtcblxuICBjb25zdCBkZXN0aW5hdGlvbiA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5RGVzdGluYXRpb24oc2NvcGUsIGAke2lkfURlbGl2ZXJ5RGVzdGluYXRpb25gLCB7XG4gICAgbmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJsb2dfZGVsaXZlcnlfZGVzdGluYXRpb25cIiwgbG9naWNhbCkubmFtZSBhcyBzdHJpbmcsXG4gICAgZGVzdGluYXRpb25SZXNvdXJjZUFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgb3V0cHV0Rm9ybWF0OiBvcHRpb25zLmZvcm1hdCA/PyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LlczQyxcbiAgfSk7XG5cbiAgbmV3IGxvZ3MuQ2ZuRGVsaXZlcnkoc2NvcGUsIGAke2lkfURlbGl2ZXJ5YCwge1xuICAgIGRlbGl2ZXJ5U291cmNlTmFtZTogc291cmNlLm5hbWUsXG4gICAgZGVsaXZlcnlEZXN0aW5hdGlvbkFybjogZGVzdGluYXRpb24uYXR0ckFybixcbiAgICByZWNvcmRGaWVsZHM6IFsuLi5DTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTXSxcbiAgfSk7XG5cbiAgcmV0dXJuIGxvZ0dyb3VwO1xufVxuXG4vKipcbiAqIFRoZSBidWNrZXQtbmFtZSBwcm9wZXJ0aWVzIHRoZSBuYW1pbmcgY29udHJhY3QgcmVxdWlyZXMuIEEgZGVyaXZlZCBwcm9maWxlXG4gKiBzZXRzIHRoZSBhY2NvdW50LXJlZ2lvbmFsIG5hbWVzcGFjZSBhbmQgcHJlZml4OyBhIGxlZ2FjeSBwaW4gc3VwcGxpZXMgdGhlXG4gKiBmdWxsIG5hbWU7IGEgbGVnYWN5IGdlbmVyYXRlZCBlbnRyeSBzZXRzIG5vIG5hbWUgc28gQ2xvdWRGb3JtYXRpb24ga2VlcHNcbiAqIHRvZGF5J3MgbmFtZSBhbmQgZ2xvYmFsIG5hbWVzcGFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1Y2tldE5hbWluZ1Byb3BzKFxuICBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICBsb2dpY2FsOiBzdHJpbmcsXG4pOiB7IGJ1Y2tldE5hbWU/OiBzdHJpbmc7IGJ1Y2tldE5hbWVzcGFjZT86IHMzLkJ1Y2tldE5hbWVzcGFjZTsgYnVja2V0TmFtZVByZWZpeD86IHN0cmluZyB9IHtcbiAgY29uc3QgY29tcG9zZWQgPSBjb250ZXh0LnBoeXNpY2FsTmFtZShcInMzX2J1Y2tldFwiLCBsb2dpY2FsKTtcbiAgaWYgKGNvbXBvc2VkLmdlbmVyYXRlZCkge1xuICAgIHJldHVybiB7fTtcbiAgfVxuICBpZiAoY29tcG9zZWQucGlubmVkKSB7XG4gICAgcmV0dXJuIHsgYnVja2V0TmFtZTogY29tcG9zZWQubmFtZSB9O1xuICB9XG4gIGlmIChjb21wb3NlZC5idWNrZXROYW1lUHJlZml4ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeSBidWNrZXQgJHtsb2dpY2FsfSByZXF1aXJlcyBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeGApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYnVja2V0TmFtZXNwYWNlOiBzMy5CdWNrZXROYW1lc3BhY2UuQUNDT1VOVF9SRUdJT05BTCxcbiAgICBidWNrZXROYW1lUHJlZml4OiBjb21wb3NlZC5idWNrZXROYW1lUHJlZml4LFxuICB9O1xufVxuIl19