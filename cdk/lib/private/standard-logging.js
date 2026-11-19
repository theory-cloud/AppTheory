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
exports.standardLogGroup = standardLogGroup;
exports.enableCloudFrontStandardLogging = enableCloudFrontStandardLogging;
exports.bucketNamingProps = bucketNamingProps;
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
    if (context.region !== "us-east-1") {
        throw new Error(`CloudFront standard logging requires a us-east-1 stack (got ${context.region}); a stack outside us-east-1 is out of the v0.1 resource-naming contract`);
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
 * sets the account-regional namespace and prefix; a legacy profile supplies the
 * pinned full name.
 */
function bucketNamingProps(context, logical, explicitName) {
    const composed = context.physicalName("s3_bucket", logical);
    if (composed.pinned) {
        if (explicitName !== undefined && explicitName !== composed.name) {
            throw new Error(`AppTheory bucket ${logical} cannot honor ${JSON.stringify(explicitName)} when the legacy pin is ${JSON.stringify(composed.name)}`);
        }
        return { bucketName: composed.name };
    }
    if (explicitName !== undefined) {
        throw new Error(`AppTheory derives the bucket name for ${logical} from the naming context; omit the explicit name or use the legacy profile with a pin`);
    }
    if (composed.bucketNamePrefix === undefined) {
        throw new Error(`AppTheory bucket ${logical} requires an account-regional prefix`);
    }
    return {
        bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
        bucketNamePrefix: composed.bucketNamePrefix,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhbmRhcmQtbG9nZ2luZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YW5kYXJkLWxvZ2dpbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNEJBLHdEQVlDO0FBS0Qsd0RBY0M7QUFNRCxvQ0FFQztBQUtELDRDQVVDO0FBV0QsMEVBbUNDO0FBT0QsOENBMEJDO0FBaktELGtFQUFvRDtBQUVwRCwyREFBNkM7QUFDN0MsdURBQXlDO0FBR3pDLHdDQUEwRDtBQUcxRDs7O0dBR0c7QUFDVSxRQUFBLHlCQUF5QixHQUFHO0lBQ3ZDLFdBQVc7SUFDWCxtQkFBbUI7SUFDbkIsV0FBVztJQUNYLGFBQWE7SUFDYixXQUFXO0lBQ1gsVUFBVTtJQUNWLFlBQVk7SUFDWixvQkFBb0I7SUFDcEIsTUFBTTtDQUNQLENBQUM7QUFFRjs7R0FFRztBQUNILFNBQWdCLHNCQUFzQjtJQUNwQyxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7UUFDakQsUUFBUSxFQUFFLDRCQUE0QjtLQUN2QyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixzQkFBc0I7SUFDcEMsT0FBTyxLQUFLLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FDakMsSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNiLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxVQUFVLEVBQUUscUJBQXFCO1FBQ2pDLFlBQVksRUFBRSx1QkFBdUI7UUFDckMsTUFB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LFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUNuSSxDQUFDO1FBQ0osQ0FBQztRQUNELE9BQU8sRUFBRSxVQUFVLEVBQUUsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO0lBQ3ZDLENBQUM7SUFDRCxJQUFJLFlBQVksS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUMvQixNQUFNLElBQUksS0FBSyxDQUNiLHlDQUF5QyxPQUFPLHVGQUF1RixDQUN4SSxDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksUUFBUSxDQUFDLGdCQUFnQixLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzVDLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLE9BQU8sc0NBQXNDLENBQUMsQ0FBQztJQUNyRixDQUFDO0lBQ0QsT0FBTztRQUNMLGVBQWUsRUFBRSxFQUFFLENBQUMsZUFBZSxDQUFDLGdCQUFnQjtRQUNwRCxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsZ0JBQWdCO0tBQzVDLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi4vbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4uL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKlxuICogVGhlIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyByZWNvcmQgZmllbGRzLCBpbiBkZWxpdmVyeSBvcmRlclxuICogKGNvbnRyYWN0IHNlY3Rpb24gMykuXG4gKi9cbmV4cG9ydCBjb25zdCBDTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTID0gW1xuICBcInRpbWVzdGFtcFwiLFxuICBcIngtZWRnZS1yZXF1ZXN0LWlkXCIsXG4gIFwiY3MtbWV0aG9kXCIsXG4gIFwiY3MtdXJpLXN0ZW1cIixcbiAgXCJzYy1zdGF0dXNcIixcbiAgXCJzYy1ieXRlc1wiLFxuICBcInRpbWUtdGFrZW5cIixcbiAgXCJ4LWVkZ2UtcmVzdWx0LXR5cGVcIixcbiAgXCJjLWlwXCIsXG5dO1xuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIEhUVFAgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgIHNvdXJjZUlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIFRoZSBBUEkgR2F0ZXdheSBhY2Nlc3MtbG9nIGZpZWxkIG5hbWVzIGFuZCB2YWx1ZXMgZm9yIFJFU1QgQVBJcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3RBcGlBY2Nlc3NMb2dGb3JtYXQoKTogYXBpZ3cuQWNjZXNzTG9nRm9ybWF0IHtcbiAgcmV0dXJuIGFwaWd3LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgcmVzb3VyY2VQYXRoOiBcIiRjb250ZXh0LnJlc291cmNlUGF0aFwiLFxuICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICByZXNwb25zZUxhdGVuY3k6IFwiJGNvbnRleHQucmVzcG9uc2VMYXRlbmN5XCIsXG4gICAgICBzb3VyY2VJcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIH0pLFxuICApO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG51bWVyaWMgcmV0ZW50aW9uIHRvIHRoZSBDbG91ZFdhdGNoIExvZ3MgZW51bS4gVGhlIGNvbnRleHQgaGFzXG4gKiBhbHJlYWR5IHZhbGlkYXRlZCB0aGUgdmFsdWUgYWdhaW5zdCB0aGUgYWNjZXB0ZWQgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0ZW50aW9uRm9yKGRheXM6IG51bWJlcik6IGxvZ3MuUmV0ZW50aW9uRGF5cyB7XG4gIHJldHVybiBkYXlzIGFzIGxvZ3MuUmV0ZW50aW9uRGF5cztcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBzdGFuZGFyZC1wcm9maWxlIGxvZyBncm91cCBuYW1lZCBmcm9tIHRoZSBuYW1pbmcgY29udHJhY3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFuZGFyZExvZ0dyb3VwKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBpZDogc3RyaW5nLFxuICBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICBsb2dpY2FsOiBzdHJpbmcsXG4pOiBsb2dzLkxvZ0dyb3VwIHtcbiAgcmV0dXJuIG5ldyBsb2dzLkxvZ0dyb3VwKHNjb3BlLCBpZCwge1xuICAgIGxvZ0dyb3VwTmFtZTogY29udGV4dC5sb2dHcm91cE5hbWUobG9naWNhbCksXG4gICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IoY29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgfSk7XG59XG5cbi8qKlxuICogV2lyZSBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgdGhyb3VnaCBDbG91ZFdhdGNoIExvZ3MgdmVuZGVkIGRlbGl2ZXJ5OlxuICogYSBkZWxpdmVyeSBzb3VyY2UsIGEgZGVsaXZlcnkgZGVzdGluYXRpb24gb3ZlciB0aGUgbG9nIGdyb3VwLCBhbmQgYSBkZWxpdmVyeVxuICogY2FycnlpbmcgdGhlIGNvbnRyYWN0J3MgcmVjb3JkIGZpZWxkcy5cbiAqXG4gKiBUaGUgY29udHJhY3QgcmVxdWlyZXMgdGhlc2UgcmVzb3VyY2VzIGluIGB1cy1lYXN0LTFgOyBhIHN0YWNrIGVsc2V3aGVyZSBpc1xuICogb3V0IG9mIHYwLjEsIHNvIHN5bnRoZXNpcyBmYWlscyBpbnN0ZWFkIG9mIGNyZWF0aW5nIGEgZGVsaXZlcnkgdGhhdCBjYW5ub3RcbiAqIHJlY2VpdmUgQ2xvdWRGcm9udCBsb2dzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyhvcHRpb25zOiB7XG4gIHJlYWRvbmx5IHNjb3BlOiBDb25zdHJ1Y3Q7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbnRleHQ6IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG4gIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5JRGlzdHJpYnV0aW9uO1xuICByZWFkb25seSBsb2dpY2FsOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGZvcm1hdD86IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQ7XG59KTogbG9ncy5Mb2dHcm91cCB7XG4gIGNvbnN0IHsgc2NvcGUsIGlkLCBjb250ZXh0LCBkaXN0cmlidXRpb24sIGxvZ2ljYWwgfSA9IG9wdGlvbnM7XG4gIGlmIChjb250ZXh0LnJlZ2lvbiAhPT0gXCJ1cy1lYXN0LTFcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDbG91ZEZyb250IHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSB1cy1lYXN0LTEgc3RhY2sgKGdvdCAke2NvbnRleHQucmVnaW9ufSk7IGEgc3RhY2sgb3V0c2lkZSB1cy1lYXN0LTEgaXMgb3V0IG9mIHRoZSB2MC4xIHJlc291cmNlLW5hbWluZyBjb250cmFjdGAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBsb2dHcm91cCA9IHN0YW5kYXJkTG9nR3JvdXAoc2NvcGUsIGAke2lkfUxvZ0dyb3VwYCwgY29udGV4dCwgbG9naWNhbCk7XG5cbiAgY29uc3Qgc291cmNlID0gbmV3IGxvZ3MuQ2ZuRGVsaXZlcnlTb3VyY2Uoc2NvcGUsIGAke2lkfURlbGl2ZXJ5U291cmNlYCwge1xuICAgIG5hbWU6IGNvbnRleHQucGh5c2ljYWxOYW1lKFwibG9nX2RlbGl2ZXJ5X3NvdXJjZVwiLCBsb2dpY2FsKS5uYW1lLFxuICAgIGxvZ1R5cGU6IFwiQUNDRVNTX0xPR1NcIixcbiAgICByZXNvdXJjZUFybjogZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkFybixcbiAgfSk7XG5cbiAgY29uc3QgZGVzdGluYXRpb24gPSBuZXcgbG9ncy5DZm5EZWxpdmVyeURlc3RpbmF0aW9uKHNjb3BlLCBgJHtpZH1EZWxpdmVyeURlc3RpbmF0aW9uYCwge1xuICAgIG5hbWU6IGNvbnRleHQucGh5c2ljYWxOYW1lKFwibG9nX2RlbGl2ZXJ5X2Rlc3RpbmF0aW9uXCIsIGxvZ2ljYWwpLm5hbWUsXG4gICAgZGVzdGluYXRpb25SZXNvdXJjZUFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgb3V0cHV0Rm9ybWF0OiBvcHRpb25zLmZvcm1hdCA/PyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LlczQyxcbiAgfSk7XG5cbiAgbmV3IGxvZ3MuQ2ZuRGVsaXZlcnkoc2NvcGUsIGAke2lkfURlbGl2ZXJ5YCwge1xuICAgIGRlbGl2ZXJ5U291cmNlTmFtZTogc291cmNlLm5hbWUsXG4gICAgZGVsaXZlcnlEZXN0aW5hdGlvbkFybjogZGVzdGluYXRpb24uYXR0ckFybixcbiAgICByZWNvcmRGaWVsZHM6IFsuLi5DTE9VRF9GUk9OVF9SRUNPUkRfRklFTERTXSxcbiAgfSk7XG5cbiAgcmV0dXJuIGxvZ0dyb3VwO1xufVxuXG4vKipcbiAqIFRoZSBidWNrZXQtbmFtZSBwcm9wZXJ0aWVzIHRoZSBuYW1pbmcgY29udHJhY3QgcmVxdWlyZXMuIEEgZGVyaXZlZCBwcm9maWxlXG4gKiBzZXRzIHRoZSBhY2NvdW50LXJlZ2lvbmFsIG5hbWVzcGFjZSBhbmQgcHJlZml4OyBhIGxlZ2FjeSBwcm9maWxlIHN1cHBsaWVzIHRoZVxuICogcGlubmVkIGZ1bGwgbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1Y2tldE5hbWluZ1Byb3BzKFxuICBjb250ZXh0OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICBsb2dpY2FsOiBzdHJpbmcsXG4gIGV4cGxpY2l0TmFtZT86IHN0cmluZyxcbik6IHsgYnVja2V0TmFtZT86IHN0cmluZzsgYnVja2V0TmFtZXNwYWNlPzogczMuQnVja2V0TmFtZXNwYWNlOyBidWNrZXROYW1lUHJlZml4Pzogc3RyaW5nIH0ge1xuICBjb25zdCBjb21wb3NlZCA9IGNvbnRleHQucGh5c2ljYWxOYW1lKFwiczNfYnVja2V0XCIsIGxvZ2ljYWwpO1xuICBpZiAoY29tcG9zZWQucGlubmVkKSB7XG4gICAgaWYgKGV4cGxpY2l0TmFtZSAhPT0gdW5kZWZpbmVkICYmIGV4cGxpY2l0TmFtZSAhPT0gY29tcG9zZWQubmFtZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5IGJ1Y2tldCAke2xvZ2ljYWx9IGNhbm5vdCBob25vciAke0pTT04uc3RyaW5naWZ5KGV4cGxpY2l0TmFtZSl9IHdoZW4gdGhlIGxlZ2FjeSBwaW4gaXMgJHtKU09OLnN0cmluZ2lmeShjb21wb3NlZC5uYW1lKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgYnVja2V0TmFtZTogY29tcG9zZWQubmFtZSB9O1xuICB9XG4gIGlmIChleHBsaWNpdE5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnkgZGVyaXZlcyB0aGUgYnVja2V0IG5hbWUgZm9yICR7bG9naWNhbH0gZnJvbSB0aGUgbmFtaW5nIGNvbnRleHQ7IG9taXQgdGhlIGV4cGxpY2l0IG5hbWUgb3IgdXNlIHRoZSBsZWdhY3kgcHJvZmlsZSB3aXRoIGEgcGluYCxcbiAgICApO1xuICB9XG4gIGlmIChjb21wb3NlZC5idWNrZXROYW1lUHJlZml4ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeSBidWNrZXQgJHtsb2dpY2FsfSByZXF1aXJlcyBhbiBhY2NvdW50LXJlZ2lvbmFsIHByZWZpeGApO1xuICB9XG4gIHJldHVybiB7XG4gICAgYnVja2V0TmFtZXNwYWNlOiBzMy5CdWNrZXROYW1lc3BhY2UuQUNDT1VOVF9SRUdJT05BTCxcbiAgICBidWNrZXROYW1lUHJlZml4OiBjb21wb3NlZC5idWNrZXROYW1lUHJlZml4LFxuICB9O1xufVxuIl19