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
    const logGroup = new logs.LogGroup(scope, id, {
        logGroupName: context.logGroupName(logical),
        retention: retentionFor(context.retentionDays),
    });
    // Contract section 11.4: declare the resource carrying the log-source name.
    context.declareName("log_group", logical, logGroup);
    return logGroup;
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
    // Contract section 11.4: declare the resources carrying the composed names.
    context.declareName("log_delivery_source", logical, source);
    const destination = new logs.CfnDeliveryDestination(scope, `${id}DeliveryDestination`, {
        name: context.physicalName("log_delivery_destination", logical).name,
        destinationResourceArn: logGroup.logGroupArn,
        outputFormat: format,
    });
    context.declareName("log_delivery_destination", logical, destination);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhbmRhcmQtbG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YW5kYXJkLWxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNkJBLHdEQVlDO0FBS0Qsd0RBY0M7QUFNRCxvQ0FFQztBQVFELGtFQVdDO0FBS0QsNENBYUM7QUFXRCwwRUEyREM7QUFRRCw4Q0FrQkM7QUF6TUQsNkNBQTJDO0FBQzNDLGtFQUFvRDtBQUVwRCwyREFBNkM7QUFDN0MsdURBQXlDO0FBR3pDLHdDQUEwRDtBQUcxRDs7O0dBR0c7QUFDVSxRQUFBLHlCQUF5QixHQUFHO0lBQ3ZDLFdBQVc7SUFDWCxtQkFBbUI7SUFDbkIsV0FBVztJQUNYLGFBQWE7SUFDYixXQUFXO0lBQ1gsVUFBVTtJQUNWLFlBQVk7SUFDWixvQkFBb0I7SUFDcEIsTUFBTTtDQUNQLENBQUM7QUFFRjs7R0FFRztBQUNILFNBQWdCLHNCQUFzQjtJQUNwQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7UUFDakQsUUFBUSxFQUFFLDRCQUE0QjtLQUN2QyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixzQkFBc0I7SUFDcEMsT0FBTyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNiLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxVQUFVLEVBQUUscUJBQXFCO1FBQ2pDLFlBQVksRUFBRSx1QkFBdUI7UUFDckMsTUFBTSxFQUFFLGlCQUFpQjtRQUN6QixRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLGNBQWMsRUFBRSx5QkFBeUI7UUFDekMsZUFBZSxFQUFFLDBCQUEwQjtRQUMzQyxRQUFRLEVBQUUsNEJBQTRCO0tBQ3ZDLENBQUMsQ0FDSCxDQUFDO0FBQ0osQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQWdCLFlBQVksQ0FBQyxJQUFZO0lBQ3ZDLE9BQU8sSUFBMEIsQ0FBQztBQUNwQyxDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxTQUFnQiwyQkFBMkI7SUFDekMsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ3BCLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxTQUFTLEVBQUUsb0JBQW9CO1FBQy9CLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsWUFBWSxFQUFFLHVCQUF1QjtRQUNyQyxNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLGtCQUFrQixFQUFFLDZCQUE2QjtRQUNqRCxRQUFRLEVBQUUsNEJBQTRCO0tBQ3ZDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRDs7R0FFRztBQUNILFNBQWdCLGdCQUFnQixDQUM5QixLQUFnQixFQUNoQixFQUFVLEVBQ1YsT0FBK0IsRUFDL0IsT0FBZTtJQUVmLE1BQU0sUUFBUSxHQUFHLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFO1FBQzVDLFlBQVksRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQztRQUMzQyxTQUFTLEVBQUUsWUFBWSxDQUFDLE9BQU8sQ0FBQyxhQUFhLENBQUM7S0FDL0MsQ0FBQyxDQUFDO0lBQ0gsNEVBQTRFO0lBQzVFLE9BQU8sQ0FBQyxXQUFXLENBQUMsV0FBVyxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztJQUNwRCxPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBRUQ7Ozs7Ozs7O0dBUUc7QUFDSCxTQUFnQiwrQkFBK0IsQ0FBQyxPQU8vQztJQUNDLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsT0FBTyxFQUFFLEdBQUcsT0FBTyxDQUFDO0lBQzlELE1BQU0sV0FBVyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUMzQyxJQUFJLENBQUMsbUJBQUssQ0FBQyxZQUFZLENBQUMsV0FBVyxDQUFDLElBQUksV0FBVyxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3BFLE1BQU0sSUFBSSxLQUFLLENBQ2IsK0RBQStELFdBQVcsMEVBQTBFLENBQ3JKLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxtQkFBSyxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQ2IsMExBQTBMLENBQzNMLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUZBQXVGLE9BQU8sQ0FBQyxNQUFNLDBFQUEwRSxDQUNoTCxDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLElBQUksc0NBQTRCLENBQUMsSUFBSSxDQUFDO0lBQ25FLElBQUksTUFBTSxLQUFLLHNDQUE0QixDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2pELE1BQU0sSUFBSSxLQUFLLENBQ2Isd0RBQXdELElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLCtRQUErUSxDQUM5VixDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sUUFBUSxHQUFHLGdCQUFnQixDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztJQUU1RSxNQUFNLE1BQU0sR0FBRyxJQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLGdCQUFnQixFQUFFO1FBQ3RFLElBQUksRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLHFCQUFxQixFQUFFLE9BQU8sQ0FBQyxDQUFDLElBQWM7UUFDekUsT0FBTyxFQUFFLGFBQWE7UUFDdEIsV0FBVyxFQUFFLFlBQVksQ0FBQyxlQUFlO0tBQzFDLENBQUMsQ0FBQztJQUNILDRFQUE0RTtJQUM1RSxPQUFPLENBQUMsV0FBVyxDQUFDLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztJQUU1RCxNQUFNLFdBQVcsR0FBRyxJQUFJLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLHFCQUFxQixFQUFFO1FBQ3JGLElBQUksRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLDBCQUEwQixFQUFFLE9BQU8sQ0FBQyxDQUFDLElBQWM7UUFDOUUsc0JBQXNCLEVBQUUsUUFBUSxDQUFDLFdBQVc7UUFDNUMsWUFBWSxFQUFFLE1BQU07S0FDckIsQ0FBQyxDQUFDO0lBQ0gsT0FBTyxDQUFDLFdBQVcsQ0FBQywwQkFBMEIsRUFBRSxPQUFPLEVBQUUsV0FBVyxDQUFDLENBQUM7SUFFdEUsTUFBTSxRQUFRLEdBQUcsSUFBSSxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFO1FBQzVELGtCQUFrQixFQUFFLE1BQU0sQ0FBQyxJQUFJO1FBQy9CLHNCQUFzQixFQUFFLFdBQVcsQ0FBQyxPQUFPO1FBQzNDLFlBQVksRUFBRSxDQUFDLEdBQUcsaUNBQXlCLENBQUM7S0FDN0MsQ0FBQyxDQUFDO0lBQ0gsOEVBQThFO0lBQzlFLDZFQUE2RTtJQUM3RSx5RUFBeUU7SUFDekUsUUFBUSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFcEMsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsU0FBZ0IsaUJBQWlCLENBQy9CLE9BQStCLEVBQy9CLE9BQWU7SUFFZixNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLFdBQVcsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUM1RCxJQUFJLFFBQVEsQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUN2QixPQUFPLEVBQUUsQ0FBQztJQUNaLENBQUM7SUFDRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNwQixPQUFPLEVBQUUsVUFBVSxFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUN2QyxDQUFDO0lBQ0QsSUFBSSxRQUFRLENBQUMsZ0JBQWdCLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDNUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsT0FBTyxzQ0FBc0MsQ0FBQyxDQUFDO0lBQ3JGLENBQUM7SUFDRCxPQUFPO1FBQ0wsZUFBZSxFQUFFLEVBQUUsQ0FBQyxlQUFlLENBQUMsZ0JBQWdCO1FBQ3BELGdCQUFnQixFQUFFLFFBQVEsQ0FBQyxnQkFBZ0I7S0FDNUMsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0IH0gZnJvbSBcIi4uL2xvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuLi9uYW1pbmctY29udGV4dFwiO1xuXG4vKipcbiAqIFRoZSBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgcmVjb3JkIGZpZWxkcywgaW4gZGVsaXZlcnkgb3JkZXJcbiAqIChjb250cmFjdCBzZWN0aW9uIDMpLlxuICovXG5leHBvcnQgY29uc3QgQ0xPVURfRlJPTlRfUkVDT1JEX0ZJRUxEUyA9IFtcbiAgXCJ0aW1lc3RhbXBcIixcbiAgXCJ4LWVkZ2UtcmVxdWVzdC1pZFwiLFxuICBcImNzLW1ldGhvZFwiLFxuICBcImNzLXVyaS1zdGVtXCIsXG4gIFwic2Mtc3RhdHVzXCIsXG4gIFwic2MtYnl0ZXNcIixcbiAgXCJ0aW1lLXRha2VuXCIsXG4gIFwieC1lZGdlLXJlc3VsdC10eXBlXCIsXG4gIFwiYy1pcFwiLFxuXTtcblxuLyoqXG4gKiBUaGUgQVBJIEdhdGV3YXkgYWNjZXNzLWxvZyBmaWVsZCBuYW1lcyBhbmQgdmFsdWVzIGZvciBIVFRQIEFQSXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBodHRwQXBpQWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICBzb3VyY2VJcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICB9KTtcbn1cblxuLyoqXG4gKiBUaGUgQVBJIEdhdGV3YXkgYWNjZXNzLWxvZyBmaWVsZCBuYW1lcyBhbmQgdmFsdWVzIGZvciBSRVNUIEFQSXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXN0QXBpQWNjZXNzTG9nRm9ybWF0KCk6IGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdCB7XG4gIHJldHVybiBhcGlndy5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKFxuICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICAgIHJlc291cmNlUGF0aDogXCIkY29udGV4dC5yZXNvdXJjZVBhdGhcIixcbiAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgICAgcmVzcG9uc2VMYXRlbmN5OiBcIiRjb250ZXh0LnJlc3BvbnNlTGF0ZW5jeVwiLFxuICAgICAgc291cmNlSXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICB9KSxcbiAgKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBudW1lcmljIHJldGVudGlvbiB0byB0aGUgQ2xvdWRXYXRjaCBMb2dzIGVudW0uIFRoZSBjb250ZXh0IGhhc1xuICogYWxyZWFkeSB2YWxpZGF0ZWQgdGhlIHZhbHVlIGFnYWluc3QgdGhlIGFjY2VwdGVkIHNldC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJldGVudGlvbkZvcihkYXlzOiBudW1iZXIpOiBsb2dzLlJldGVudGlvbkRheXMge1xuICByZXR1cm4gZGF5cyBhcyBsb2dzLlJldGVudGlvbkRheXM7XG59XG5cbi8qKlxuICogVGhlIEFQSSBHYXRld2F5IGFjY2Vzcy1sb2cgZmllbGQgbmFtZXMgYW5kIHZhbHVlcyBmb3IgV2ViU29ja2V0IEFQSXNcbiAqIChjb250cmFjdCBzZWN0aW9uIDMsIEFEVi0xMzExLTUpLiBUaGUgV2ViU29ja2V0IGxvZ2dpbmctdmFyaWFibGVzIGxpc3QgaGFzIG5vXG4gKiBwcm90b2NvbCwgSFRUUCBtZXRob2Qgb3IgcmVzcG9uc2UgbGVuZ3RoLCBzbyB0aGUgc2hhcmVkIEhUVFAgZmllbGQgc2V0IGRvZXNcbiAqIG5vdCBhcHBseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdlYlNvY2tldEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGV2ZW50VHlwZTogXCIkY29udGV4dC5ldmVudFR5cGVcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIGNvbm5lY3Rpb25JZDogXCIkY29udGV4dC5jb25uZWN0aW9uSWRcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgIHNvdXJjZUlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIHN0YW5kYXJkLXByb2ZpbGUgbG9nIGdyb3VwIG5hbWVkIGZyb20gdGhlIG5hbWluZyBjb250cmFjdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YW5kYXJkTG9nR3JvdXAoXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIGlkOiBzdHJpbmcsXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gIGxvZ2ljYWw6IHN0cmluZyxcbik6IGxvZ3MuTG9nR3JvdXAge1xuICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHNjb3BlLCBpZCwge1xuICAgIGxvZ0dyb3VwTmFtZTogY29udGV4dC5sb2dHcm91cE5hbWUobG9naWNhbCksXG4gICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IoY29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgfSk7XG4gIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogZGVjbGFyZSB0aGUgcmVzb3VyY2UgY2FycnlpbmcgdGhlIGxvZy1zb3VyY2UgbmFtZS5cbiAgY29udGV4dC5kZWNsYXJlTmFtZShcImxvZ19ncm91cFwiLCBsb2dpY2FsLCBsb2dHcm91cCk7XG4gIHJldHVybiBsb2dHcm91cDtcbn1cblxuLyoqXG4gKiBXaXJlIENsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnk6XG4gKiBhIGRlbGl2ZXJ5IHNvdXJjZSwgYSBkZWxpdmVyeSBkZXN0aW5hdGlvbiBvdmVyIHRoZSBsb2cgZ3JvdXAsIGFuZCBhIGRlbGl2ZXJ5XG4gKiBjYXJyeWluZyB0aGUgY29udHJhY3QncyByZWNvcmQgZmllbGRzLlxuICpcbiAqIFRoZSBjb250cmFjdCByZXF1aXJlcyB0aGVzZSByZXNvdXJjZXMgaW4gYHVzLWVhc3QtMWA7IGEgc3RhY2sgZWxzZXdoZXJlIGlzXG4gKiBvdXQgb2YgdjAuMSwgc28gc3ludGhlc2lzIGZhaWxzIGluc3RlYWQgb2YgY3JlYXRpbmcgYSBkZWxpdmVyeSB0aGF0IGNhbm5vdFxuICogcmVjZWl2ZSBDbG91ZEZyb250IGxvZ3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nKG9wdGlvbnM6IHtcbiAgcmVhZG9ubHkgc2NvcGU6IENvbnN0cnVjdDtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGV4dDogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcbiAgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LklEaXN0cmlidXRpb247XG4gIHJlYWRvbmx5IGxvZ2ljYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgZm9ybWF0PzogQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdDtcbn0pOiBsb2dzLkxvZ0dyb3VwIHtcbiAgY29uc3QgeyBzY29wZSwgaWQsIGNvbnRleHQsIGRpc3RyaWJ1dGlvbiwgbG9naWNhbCB9ID0gb3B0aW9ucztcbiAgY29uc3Qgc3RhY2tSZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChzdGFja1JlZ2lvbikgJiYgc3RhY2tSZWdpb24gIT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2xvdWRGcm9udCBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgdXMtZWFzdC0xIHN0YWNrIChnb3QgJHtzdGFja1JlZ2lvbn0pOyBhIHN0YWNrIG91dHNpZGUgdXMtZWFzdC0xIGlzIG91dCBvZiB0aGUgdjAuMSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3RgLFxuICAgICk7XG4gIH1cbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChzdGFja1JlZ2lvbikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkNsb3VkRnJvbnQgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIHJlc29sdmVkIHN0YWNrIHJlZ2lvbjsgYW4gZW52aXJvbm1lbnQtYWdub3N0aWMgc3RhY2sgY2Fubm90IHByb3ZlIHRoZSBkZWxpdmVyeSBsaXZlcyBpbiB1cy1lYXN0LTEgYW5kIGlzIG91dCBvZiB0aGUgdjAuMSByZXNvdXJjZS1uYW1pbmcgY29udHJhY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChjb250ZXh0LnJlZ2lvbiAhPT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgdGhlIG5hbWluZyBjb250ZXh0IHJlZ2lvbiB0byBiZSB1cy1lYXN0LTEgKGdvdCAke2NvbnRleHQucmVnaW9ufSk7IGEgc3RhY2sgb3V0c2lkZSB1cy1lYXN0LTEgaXMgb3V0IG9mIHRoZSB2MC4xIHJlc291cmNlLW5hbWluZyBjb250cmFjdGAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBmb3JtYXQgPSBvcHRpb25zLmZvcm1hdCA/PyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT047XG4gIGlmIChmb3JtYXQgIT09IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgY2Fubm90IHVzZSBvdXRwdXQgZm9ybWF0ICR7SlNPTi5zdHJpbmdpZnkoZm9ybWF0KX0gZm9yIGEgQ2xvdWRXYXRjaCBMb2dzIGRlbGl2ZXJ5IGRlc3RpbmF0aW9uOiB0aGUgcmVzb3VyY2UtbmFtaW5nIGNvbnRyYWN0IHNlY3Rpb24gMyBzZXR0bGVzIENsb3VkRnJvbnQgQUNDRVNTX0xPR1MgdG8gQ2xvdWRXYXRjaCBMb2dzIG9uIFwianNvblwiIChEZXNjcmliZUNvbmZpZ3VyYXRpb25UZW1wbGF0ZXMgYWxsb3dzIG9ubHkgXCJwbGFpblwiIGFuZCBcImpzb25cIiwgYW5kIFwidzNjXCIgaXMgUzMtb25seSkuIFVzZSBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT04uYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGxvZ0dyb3VwID0gc3RhbmRhcmRMb2dHcm91cChzY29wZSwgYCR7aWR9TG9nR3JvdXBgLCBjb250ZXh0LCBsb2dpY2FsKTtcblxuICBjb25zdCBzb3VyY2UgPSBuZXcgbG9ncy5DZm5EZWxpdmVyeVNvdXJjZShzY29wZSwgYCR7aWR9RGVsaXZlcnlTb3VyY2VgLCB7XG4gICAgbmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJsb2dfZGVsaXZlcnlfc291cmNlXCIsIGxvZ2ljYWwpLm5hbWUgYXMgc3RyaW5nLFxuICAgIGxvZ1R5cGU6IFwiQUNDRVNTX0xPR1NcIixcbiAgICByZXNvdXJjZUFybjogZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgfSk7XG4gIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogZGVjbGFyZSB0aGUgcmVzb3VyY2VzIGNhcnJ5aW5nIHRoZSBjb21wb3NlZCBuYW1lcy5cbiAgY29udGV4dC5kZWNsYXJlTmFtZShcImxvZ19kZWxpdmVyeV9zb3VyY2VcIiwgbG9naWNhbCwgc291cmNlKTtcblxuICBjb25zdCBkZXN0aW5hdGlvbiA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5RGVzdGluYXRpb24oc2NvcGUsIGAke2lkfURlbGl2ZXJ5RGVzdGluYXRpb25gLCB7XG4gICAgbmFtZTogY29udGV4dC5waHlzaWNhbE5hbWUoXCJsb2dfZGVsaXZlcnlfZGVzdGluYXRpb25cIiwgbG9naWNhbCkubmFtZSBhcyBzdHJpbmcsXG4gICAgZGVzdGluYXRpb25SZXNvdXJjZUFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgb3V0cHV0Rm9ybWF0OiBmb3JtYXQsXG4gIH0pO1xuICBjb250ZXh0LmRlY2xhcmVOYW1lKFwibG9nX2RlbGl2ZXJ5X2Rlc3RpbmF0aW9uXCIsIGxvZ2ljYWwsIGRlc3RpbmF0aW9uKTtcblxuICBjb25zdCBkZWxpdmVyeSA9IG5ldyBsb2dzLkNmbkRlbGl2ZXJ5KHNjb3BlLCBgJHtpZH1EZWxpdmVyeWAsIHtcbiAgICBkZWxpdmVyeVNvdXJjZU5hbWU6IHNvdXJjZS5uYW1lLFxuICAgIGRlbGl2ZXJ5RGVzdGluYXRpb25Bcm46IGRlc3RpbmF0aW9uLmF0dHJBcm4sXG4gICAgcmVjb3JkRmllbGRzOiBbLi4uQ0xPVURfRlJPTlRfUkVDT1JEX0ZJRUxEU10sXG4gIH0pO1xuICAvLyBUaGUgZGVsaXZlcnkgc291cmNlIGlzIG5hbWVkIGJ5IGEgbGl0ZXJhbCBzdHJpbmcsIHNvIENsb3VkRm9ybWF0aW9uIHNlZXMgbm9cbiAgLy8gZWRnZSBmcm9tIHRoZSBkZWxpdmVyeSB0byB0aGUgc291cmNlOyB0aGUgc291cmNlIHdhaXRzIG9uIHRoZSBkaXN0cmlidXRpb25cbiAgLy8gQVJOLCBzbyBhbiB1bm9yZGVyZWQgZGVsaXZlcnkgY2FuIGJlIGNyZWF0ZWQgYmVmb3JlIGl0cyBzb3VyY2UgZXhpc3RzLlxuICBkZWxpdmVyeS5ub2RlLmFkZERlcGVuZGVuY3koc291cmNlKTtcblxuICByZXR1cm4gbG9nR3JvdXA7XG59XG5cbi8qKlxuICogVGhlIGJ1Y2tldC1uYW1lIHByb3BlcnRpZXMgdGhlIG5hbWluZyBjb250cmFjdCByZXF1aXJlcy4gQSBkZXJpdmVkIHByb2ZpbGVcbiAqIHNldHMgdGhlIGFjY291bnQtcmVnaW9uYWwgbmFtZXNwYWNlIGFuZCBwcmVmaXg7IGEgbGVnYWN5IHBpbiBzdXBwbGllcyB0aGVcbiAqIGZ1bGwgbmFtZTsgYSBsZWdhY3kgZ2VuZXJhdGVkIGVudHJ5IHNldHMgbm8gbmFtZSBzbyBDbG91ZEZvcm1hdGlvbiBrZWVwc1xuICogdG9kYXkncyBuYW1lIGFuZCBnbG9iYWwgbmFtZXNwYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVja2V0TmFtaW5nUHJvcHMoXG4gIGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gIGxvZ2ljYWw6IHN0cmluZyxcbik6IHsgYnVja2V0TmFtZT86IHN0cmluZzsgYnVja2V0TmFtZXNwYWNlPzogczMuQnVja2V0TmFtZXNwYWNlOyBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nIH0ge1xuICBjb25zdCBjb21wb3NlZCA9IGNvbnRleHQucGh5c2ljYWxOYW1lKFwiczNfYnVja2V0XCIsIGxvZ2ljYWwpO1xuICBpZiAoY29tcG9zZWQuZ2VuZXJhdGVkKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGlmIChjb21wb3NlZC5waW5uZWQpIHtcbiAgICByZXR1cm4geyBidWNrZXROYW1lOiBjb21wb3NlZC5uYW1lIH07XG4gIH1cbiAgaWYgKGNvbXBvc2VkLmJ1Y2tldE5hbWVQcmVmaXggPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5IGJ1Y2tldCAke2xvZ2ljYWx9IHJlcXVpcmVzIGFuIGFjY291bnQtcmVnaW9uYWwgcHJlZml4YCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBidWNrZXROYW1lc3BhY2U6IHMzLkJ1Y2tldE5hbWVzcGFjZS5BQ0NPVU5UX1JFR0lPTkFMLFxuICAgIGJ1Y2tldE5hbWVQcmVmaXg6IGNvbXBvc2VkLmJ1Y2tldE5hbWVQcmVmaXgsXG4gIH07XG59XG4iXX0=