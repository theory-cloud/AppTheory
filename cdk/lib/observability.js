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
exports.AppTheoryObservability = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudwatch = __importStar(require("aws-cdk-lib/aws-cloudwatch"));
const constructs_1 = require("constructs");
/**
 * Dashboard and alarms for AppTheory's first-party runtime metrics.
 */
class AppTheoryObservability extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryObservability", version: "4.4.2" };
    dashboard;
    requestCount;
    requestDuration;
    requestErrors;
    requestErrorsAlarm;
    requestDurationAlarm;
    constructor(scope, id, props = {}) {
        super(scope, id);
        const namespace = normalized(props.metricNamespace, "AppTheory");
        const service = normalized(props.serviceName, "apptheory");
        const period = props.period ?? aws_cdk_lib_1.Duration.minutes(5);
        const alarmDimensions = dimensionsMap(props.alarmDimensions ?? { service });
        this.requestCount = metricInsights(namespace, alarmDimensions, "RequestCount", "SUM", period);
        this.requestDuration = metricInsights(namespace, alarmDimensions, "RequestDuration", "MAX", period);
        this.requestErrors = metricInsights(namespace, alarmDimensions, "RequestErrors", "SUM", period);
        this.requestErrorsAlarm = new cloudwatch.Alarm(this, "RequestErrorsAlarm", {
            metric: this.requestErrors,
            threshold: props.requestErrorThreshold ?? 1,
            evaluationPeriods: props.evaluationPeriods ?? 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        this.requestDurationAlarm = new cloudwatch.Alarm(this, "RequestDurationAlarm", {
            metric: this.requestDuration,
            threshold: props.requestDurationThresholdMs ?? 1000,
            evaluationPeriods: props.evaluationPeriods ?? 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        if (props.createDashboard ?? true) {
            this.dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
                dashboardName: props.dashboardName,
            });
            this.dashboard.addWidgets(new cloudwatch.GraphWidget({
                title: "AppTheory Request Count",
                left: [searchMetric(namespace, service, "RequestCount", "Sum", period)],
            }), new cloudwatch.GraphWidget({
                title: "AppTheory Request Duration p95",
                left: [searchMetric(namespace, service, "RequestDuration", "p95", period)],
            }), new cloudwatch.GraphWidget({
                title: "AppTheory Request Errors",
                left: [searchMetric(namespace, service, "RequestErrors", "Sum", period)],
            }));
        }
    }
}
exports.AppTheoryObservability = AppTheoryObservability;
function metricInsights(namespace, dimensions, metricName, aggregate, period) {
    return new cloudwatch.MathExpression({
        expression: metricInsightsQuery(namespace, dimensions, metricName, aggregate),
        label: metricName,
        period,
    });
}
function metricInsightsQuery(namespace, dimensions, metricName, aggregate) {
    const where = Object.entries(dimensions)
        .map(([key, value]) => `${key} = '${escapeSingleQuoted(value)}'`)
        .join(" AND ");
    return [
        `SELECT ${aggregate}(${metricName})`,
        `FROM SCHEMA("${escapeDoubleQuoted(namespace)}", service, method, path, status, tenant_id, error_code)`,
        where ? `WHERE ${where}` : "",
    ].filter(Boolean).join(" ");
}
function searchMetric(namespace, service, metricName, statistic, period) {
    return new cloudwatch.MathExpression({
        expression: `SEARCH('{${namespace},service,method,path,status,tenant_id,error_code} MetricName="${metricName}" service="${service}"', '${statistic}', ${period.toSeconds()})`,
        label: metricName,
        period,
    });
}
function dimensionsMap(input) {
    const out = { service: normalized(input.service, "apptheory") };
    if (input.method !== undefined)
        out.method = String(input.method);
    if (input.path !== undefined)
        out.path = String(input.path);
    if (input.status !== undefined)
        out.status = String(input.status);
    if (input.tenantId !== undefined)
        out.tenant_id = String(input.tenantId);
    if (input.errorCode !== undefined)
        out.error_code = String(input.errorCode);
    return out;
}
function normalized(input, fallback) {
    const value = String(input ?? "").trim();
    return value || fallback;
}
function escapeDoubleQuoted(input) {
    return String(input).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function escapeSingleQuoted(input) {
    return String(input).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2JzZXJ2YWJpbGl0eS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm9ic2VydmFiaWxpdHkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUF1QztBQUN2Qyx1RUFBeUQ7QUFDekQsMkNBQXVDO0FBNkd2Qzs7R0FFRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsc0JBQVM7O0lBQ25DLFNBQVMsQ0FBd0I7SUFDakMsWUFBWSxDQUFxQjtJQUNqQyxlQUFlLENBQXFCO0lBQ3BDLGFBQWEsQ0FBcUI7SUFDbEMsa0JBQWtCLENBQW1CO0lBQ3JDLG9CQUFvQixDQUFtQjtJQUV2RCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLFFBQXFDLEVBQUU7UUFDL0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLGVBQWUsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUNqRSxNQUFNLE9BQU8sR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLFdBQVcsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUMzRCxNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxJQUFJLHNCQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ25ELE1BQU0sZUFBZSxHQUFHLGFBQWEsQ0FBQyxLQUFLLENBQUMsZUFBZSxJQUFJLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUU1RSxJQUFJLENBQUMsWUFBWSxHQUFHLGNBQWMsQ0FBQyxTQUFTLEVBQUUsZUFBZSxFQUFFLGNBQWMsRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFDOUYsSUFBSSxDQUFDLGVBQWUsR0FBRyxjQUFjLENBQUMsU0FBUyxFQUFFLGVBQWUsRUFBRSxpQkFBaUIsRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFDcEcsSUFBSSxDQUFD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QUFNLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2xFLElBQUksS0FBSyxDQUFDLFFBQVEsS0FBSyxTQUFTO1FBQUUsR0FBRyxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ3pFLElBQUksS0FBSyxDQUFDLFNBQVMsS0FBSyxTQUFTO1FBQUUsR0FBRyxDQUFDLFVBQVUsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLEtBQXlCLEVBQUUsUUFBZ0I7SUFDN0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUN6QyxPQUFPLEtBQUssSUFBSSxRQUFRLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsS0FBYTtJQUN2QyxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDbkUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsS0FBYTtJQUN2QyxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDbkUsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaFwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuLyoqXG4gKiBEaW1lbnNpb25zIGZvciBBcHBUaGVvcnkgRU1GIHJlcXVlc3QgbWV0cmljcy5cbiAqXG4gKiBUaGUgcnVudGltZSBlbWl0cyBtZXRyaWNzIGluIG5hbWVzcGFjZSBgQXBwVGhlb3J5YCB3aXRoIG1ldHJpYyBuYW1lc1xuICogYFJlcXVlc3RDb3VudGAsIGBSZXF1ZXN0RHVyYXRpb25gLCBhbmQgYFJlcXVlc3RFcnJvcnNgLiBFTUYgZGltZW5zaW9ucyBhcmU6XG4gKiBgc2VydmljZWAsIGBtZXRob2RgLCBgcGF0aGAsIGBzdGF0dXNgLCBgdGVuYW50X2lkYCwgYW5kIGBlcnJvcl9jb2RlYC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlSZXF1ZXN0TWV0cmljRGltZW5zaW9ucyB7XG4gIC8qKlxuICAgKiBBcHBUaGVvcnkgc2VydmljZSBkaW1lbnNpb24uXG4gICAqIEBkZWZhdWx0IFwiYXBwdGhlb3J5XCJcbiAgICovXG4gIHJlYWRvbmx5IHNlcnZpY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEhUVFAgbWV0aG9kIGRpbWVuc2lvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtZXRob2Q/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEhUVFAgcm91dGUvcGF0aCBkaW1lbnNpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogSFRUUCBzdGF0dXMgZGltZW5zaW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YXR1cz86IHN0cmluZztcblxuICAvKipcbiAgICogVGVuYW50IGlkIGRpbWVuc2lvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0ZW5hbnRJZD86IHN0cmluZztcblxuICAvKipcbiAgICogRXJyb3IgY29kZSBkaW1lbnNpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZXJyb3JDb2RlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU9ic2VydmFiaWxpdHlQcm9wcyB7XG4gIC8qKlxuICAgKiBDbG91ZFdhdGNoIG1ldHJpYyBuYW1lc3BhY2UgZW1pdHRlZCBieSBBcHBUaGVvcnkgRU1GIHNpbmtzLlxuICAgKiBAZGVmYXVsdCBcIkFwcFRoZW9yeVwiXG4gICAqL1xuICByZWFkb25seSBtZXRyaWNOYW1lc3BhY2U/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFNlcnZpY2UgZGltZW5zaW9uIGVtaXR0ZWQgYnkgdGhlIHJ1bnRpbWUuXG4gICAqIEBkZWZhdWx0IFwiYXBwdGhlb3J5XCJcbiAgICovXG4gIHJlYWRvbmx5IHNlcnZpY2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBkaW1lbnNpb24gZmlsdGVycyBmb3IgYWxhcm0gTWV0cmljcyBJbnNpZ2h0cyBxdWVyaWVzLlxuICAgKlxuICAgKiBUaGUgcnVudGltZSBlbWl0cyBvbmx5IHRoZSBmdWxsIEFwcFRoZW9yeSBFTUYgZGltZW5zaW9uIHNldCwgc28gZGVmYXVsdFxuICAgKiBhbGFybXMgdXNlIE1ldHJpY3MgSW5zaWdodHMgb3ZlciB0aGF0IHNjaGVtYSBpbnN0ZWFkIG9mIHNlcnZpY2Utb25seVxuICAgKiBDbG91ZFdhdGNoIG1ldHJpYyBkaW1lbnNpb25zLlxuICAgKlxuICAgKiBEYXNoYm9hcmQgc2VhcmNoIHdpZGdldHMgYWxzbyB1c2UgdGhlIGZ1bGwgQXBwVGhlb3J5IEVNRiBzY2hlbWEuXG4gICAqIEBkZWZhdWx0IHsgc2VydmljZTogc2VydmljZU5hbWUgfVxuICAgKi9cbiAgcmVhZG9ubHkgYWxhcm1EaW1lbnNpb25zPzogQXBwVGhlb3J5UmVxdWVzdE1ldHJpY0RpbWVuc2lvbnM7XG5cbiAgLyoqXG4gICAqIERhc2hib2FyZCBuYW1lLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRhc2hib2FyZE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE1ldHJpYyBwZXJpb2QuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLm1pbnV0ZXMoNSlcbiAgICovXG4gIHJlYWRvbmx5IHBlcmlvZD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBSZXF1ZXN0IGVycm9yIGFsYXJtIHRocmVzaG9sZCBvdmVyIHRoZSBwZXJpb2QuXG4gICAqIEBkZWZhdWx0IDFcbiAgICovXG4gIHJlYWRvbmx5IHJlcXVlc3RFcnJvclRocmVzaG9sZD86IG51bWJlcjtcblxuICAvKipcbiAgICogUmVxdWVzdCBkdXJhdGlvbiBhbGFybSB0aHJlc2hvbGQgaW4gbWlsbGlzZWNvbmRzLlxuICAgKiBAZGVmYXVsdCAxMDAwXG4gICAqL1xuICByZWFkb25seSByZXF1ZXN0RHVyYXRpb25UaHJlc2hvbGRNcz86IG51bWJlcjtcblxuICAvKipcbiAgICogQWxhcm0gZXZhbHVhdGlvbiBwZXJpb2RzLlxuICAgKiBAZGVmYXVsdCAxXG4gICAqL1xuICByZWFkb25seSBldmFsdWF0aW9uUGVyaW9kcz86IG51bWJlcjtcblxuICAvKipcbiAgICogV2hldGhlciB0byBjcmVhdGUgdGhlIGRhc2hib2FyZC5cbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgY3JlYXRlRGFzaGJvYXJkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBEYXNoYm9hcmQgYW5kIGFsYXJtcyBmb3IgQXBwVGhlb3J5J3MgZmlyc3QtcGFydHkgcnVudGltZSBtZXRyaWNzLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5T2JzZXJ2YWJpbGl0eSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBkYXNoYm9hcmQ/OiBjbG91ZHdhdGNoLkRhc2hib2FyZDtcbiAgcHVibGljIHJlYWRvbmx5IHJlcXVlc3RDb3VudDogY2xvdWR3YXRjaC5JTWV0cmljO1xuICBwdWJsaWMgcmVhZG9ubHkgcmVxdWVzdER1cmF0aW9uOiBjbG91ZHdhdGNoLklNZXRyaWM7XG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0RXJyb3JzOiBjbG91ZHdhdGNoLklNZXRyaWM7XG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0RXJyb3JzQWxhcm06IGNsb3Vkd2F0Y2guQWxhcm07XG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0RHVyYXRpb25BbGFybTogY2xvdWR3YXRjaC5BbGFybTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5T2JzZXJ2YWJpbGl0eVByb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgbmFtZXNwYWNlID0gbm9ybWFsaXplZChwcm9wcy5tZXRyaWNOYW1lc3BhY2UsIFwiQXBwVGhlb3J5XCIpO1xuICAgIGNvbnN0IHNlcnZpY2UgPSBub3JtYWxpemVkKHByb3BzLnNlcnZpY2VOYW1lLCBcImFwcHRoZW9yeVwiKTtcbiAgICBjb25zdCBwZXJpb2QgPSBwcm9wcy5wZXJpb2QgPz8gRHVyYXRpb24ubWludXRlcyg1KTtcbiAgICBjb25zdCBhbGFybURpbWVuc2lvbnMgPSBkaW1lbnNpb25zTWFwKHByb3BzLmFsYXJtRGltZW5zaW9ucyA/PyB7IHNlcnZpY2UgfSk7XG5cbiAgICB0aGlzLnJlcXVlc3RDb3VudCA9IG1ldHJpY0luc2lnaHRzKG5hbWVzcGFjZSwgYWxhcm1EaW1lbnNpb25zLCBcIlJlcXVlc3RDb3VudFwiLCBcIlNVTVwiLCBwZXJpb2QpO1xuICAgIHRoaXMucmVxdWVzdER1cmF0aW9uID0gbWV0cmljSW5zaWdodHMobmFtZXNwYWNlLCBhbGFybURpbWVuc2lvbnMsIFwiUmVxdWVzdER1cmF0aW9uXCIsIFwiTUFYXCIsIHBlcmlvZCk7XG4gICAgdGhpcy5yZXF1ZXN0RXJyb3JzID0gbWV0cmljSW5zaWdodHMobmFtZXNwYWNlLCBhbGFybURpbWVuc2lvbnMsIFwiUmVxdWVzdEVycm9yc1wiLCBcIlNVTVwiLCBwZXJpb2QpO1xuXG4gICAgdGhpcy5yZXF1ZXN0RXJyb3JzQWxhcm0gPSBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBcIlJlcXVlc3RFcnJvcnNBbGFybVwiLCB7XG4gICAgICBtZXRyaWM6IHRoaXMucmVxdWVzdEVycm9ycyxcbiAgICAgIHRocmVzaG9sZDogcHJvcHMucmVxdWVzdEVycm9yVGhyZXNob2xkID8/IDEsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogcHJvcHMuZXZhbHVhdGlvblBlcmlvZHMgPz8gMSxcbiAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogY2xvdWR3YXRjaC5Db21wYXJpc29uT3BlcmF0b3IuR1JFQVRFUl9USEFOX09SX0VRVUFMX1RPX1RIUkVTSE9MRCxcbiAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5OT1RfQlJFQUNISU5HLFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZXF1ZXN0RHVyYXRpb25BbGFybSA9IG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsIFwiUmVxdWVzdER1cmF0aW9uQWxhcm1cIiwge1xuICAgICAgbWV0cmljOiB0aGlzLnJlcXVlc3REdXJhdGlvbixcbiAgICAgIHRocmVzaG9sZDogcHJvcHMucmVxdWVzdER1cmF0aW9uVGhyZXNob2xkTXMgPz8gMTAwMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiBwcm9wcy5ldmFsdWF0aW9uUGVyaW9kcyA/PyAxLFxuICAgICAgY29tcGFyaXNvbk9wZXJhdG9yOiBjbG91ZHdhdGNoLkNvbXBhcmlzb25PcGVyYXRvci5HUkVBVEVSX1RIQU5fT1JfRVFVQUxfVE9fVEhSRVNIT0xELFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogY2xvdWR3YXRjaC5UcmVhdE1pc3NpbmdEYXRhLk5PVF9CUkVBQ0hJTkcsXG4gICAgfSk7XG5cbiAgICBpZiAocHJvcHMuY3JlYXRlRGFzaGJvYXJkID8/IHRydWUpIHtcbiAgICAgIHRoaXMuZGFzaGJvYXJkID0gbmV3IGNsb3Vkd2F0Y2guRGFzaGJvYXJkKHRoaXMsIFwiRGFzaGJvYXJkXCIsIHtcbiAgICAgICAgZGFzaGJvYXJkTmFtZTogcHJvcHMuZGFzaGJvYXJkTmFtZSxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5kYXNoYm9hcmQuYWRkV2lkZ2V0cyhcbiAgICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICAgIHRpdGxlOiBcIkFwcFRoZW9yeSBSZXF1ZXN0IENvdW50XCIsXG4gICAgICAgICAgbGVmdDogW3NlYXJjaE1ldHJpYyhuYW1lc3BhY2UsIHNlcnZpY2UsIFwiUmVxdWVzdENvdW50XCIsIFwiU3VtXCIsIHBlcmlvZCldLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgICAgIHRpdGxlOiBcIkFwcFRoZW9yeSBSZXF1ZXN0IER1cmF0aW9uIHA5NVwiLFxuICAgICAgICAgIGxlZnQ6IFtzZWFyY2hNZXRyaWMobmFtZXNwYWNlLCBzZXJ2aWNlLCBcIlJlcXVlc3REdXJhdGlvblwiLCBcInA5NVwiLCBwZXJpb2QpXSxcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgICAgICB0aXRsZTogXCJBcHBUaGVvcnkgUmVxdWVzdCBFcnJvcnNcIixcbiAgICAgICAgICBsZWZ0OiBbc2VhcmNoTWV0cmljKG5hbWVzcGFjZSwgc2VydmljZSwgXCJSZXF1ZXN0RXJyb3JzXCIsIFwiU3VtXCIsIHBlcmlvZCldLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG1ldHJpY0luc2lnaHRzKFxuICBuYW1lc3BhY2U6IHN0cmluZyxcbiAgZGltZW5zaW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbiAgbWV0cmljTmFtZTogc3RyaW5nLFxuICBhZ2dyZWdhdGU6IFwiTUFYXCIgfCBcIlNVTVwiLFxuICBwZXJpb2Q6IER1cmF0aW9uLFxuKTogY2xvdWR3YXRjaC5NYXRoRXhwcmVzc2lvbiB7XG4gIHJldHVybiBuZXcgY2xvdWR3YXRjaC5NYXRoRXhwcmVzc2lvbih7XG4gICAgZXhwcmVzc2lvbjogbWV0cmljSW5zaWdodHNRdWVyeShuYW1lc3BhY2UsIGRpbWVuc2lvbnMsIG1ldHJpY05hbWUsIGFnZ3JlZ2F0ZSksXG4gICAgbGFiZWw6IG1ldHJpY05hbWUsXG4gICAgcGVyaW9kLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gbWV0cmljSW5zaWdodHNRdWVyeShcbiAgbmFtZXNwYWNlOiBzdHJpbmcsXG4gIGRpbWVuc2lvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4gIG1ldHJpY05hbWU6IHN0cmluZyxcbiAgYWdncmVnYXRlOiBcIk1BWFwiIHwgXCJTVU1cIixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHdoZXJlID0gT2JqZWN0LmVudHJpZXMoZGltZW5zaW9ucylcbiAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IGAke2tleX0gPSAnJHtlc2NhcGVTaW5nbGVRdW90ZWQodmFsdWUpfSdgKVxuICAgIC5qb2luKFwiIEFORCBcIik7XG4gIHJldHVybiBbXG4gICAgYFNFTEVDVCAke2FnZ3JlZ2F0ZX0oJHttZXRyaWNOYW1lfSlgLFxuICAgIGBGUk9NIFNDSEVNQShcIiR7ZXNjYXBlRG91YmxlUXVvdGVkKG5hbWVzcGFjZSl9XCIsIHNlcnZpY2UsIG1ldGhvZCwgcGF0aCwgc3RhdHVzLCB0ZW5hbnRfaWQsIGVycm9yX2NvZGUpYCxcbiAgICB3aGVyZSA/IGBXSEVSRSAke3doZXJlfWAgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcbn1cblxuZnVuY3Rpb24gc2VhcmNoTWV0cmljKG5hbWVzcGFjZTogc3RyaW5nLCBzZXJ2aWNlOiBzdHJpbmcsIG1ldHJpY05hbWU6IHN0cmluZywgc3RhdGlzdGljOiBzdHJpbmcsIHBlcmlvZDogRHVyYXRpb24pOiBjbG91ZHdhdGNoLk1hdGhFeHByZXNzaW9uIHtcbiAgcmV0dXJuIG5ldyBjbG91ZHdhdGNoLk1hdGhFeHByZXNzaW9uKHtcbiAgICBleHByZXNzaW9uOiBgU0VBUkNIKCd7JHtuYW1lc3BhY2V9LHNlcnZpY2UsbWV0aG9kLHBhdGgsc3RhdHVzLHRlbmFudF9pZCxlcnJvcl9jb2RlfSBNZXRyaWNOYW1lPVwiJHttZXRyaWNOYW1lfVwiIHNlcnZpY2U9XCIke3NlcnZpY2V9XCInLCAnJHtzdGF0aXN0aWN9JywgJHtwZXJpb2QudG9TZWNvbmRzKCl9KWAsXG4gICAgbGFiZWw6IG1ldHJpY05hbWUsXG4gICAgcGVyaW9kLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gZGltZW5zaW9uc01hcChpbnB1dDogQXBwVGhlb3J5UmVxdWVzdE1ldHJpY0RpbWVuc2lvbnMpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyBzZXJ2aWNlOiBub3JtYWxpemVkKGlucHV0LnNlcnZpY2UsIFwiYXBwdGhlb3J5XCIpIH07XG4gIGlmIChpbnB1dC5tZXRob2QgIT09IHVuZGVmaW5lZCkgb3V0Lm1ldGhvZCA9IFN0cmluZyhpbnB1dC5tZXRob2QpO1xuICBpZiAoaW5wdXQucGF0aCAhPT0gdW5kZWZpbmVkKSBvdXQucGF0aCA9IFN0cmluZyhpbnB1dC5wYXRoKTtcbiAgaWYgKGlucHV0LnN0YXR1cyAhPT0gdW5kZWZpbmVkKSBvdXQuc3RhdHVzID0gU3RyaW5nKGlucHV0LnN0YXR1cyk7XG4gIGlmIChpbnB1dC50ZW5hbnRJZCAhPT0gdW5kZWZpbmVkKSBvdXQudGVuYW50X2lkID0gU3RyaW5nKGlucHV0LnRlbmFudElkKTtcbiAgaWYgKGlucHV0LmVycm9yQ29kZSAhPT0gdW5kZWZpbmVkKSBvdXQuZXJyb3JfY29kZSA9IFN0cmluZyhpbnB1dC5lcnJvckNvZGUpO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVkKGlucHV0OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB2YWx1ZSA9IFN0cmluZyhpbnB1dCA/PyBcIlwiKS50cmltKCk7XG4gIHJldHVybiB2YWx1ZSB8fCBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZXNjYXBlRG91YmxlUXVvdGVkKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKGlucHV0KS5yZXBsYWNlKC9cXFxcL2csIFwiXFxcXFxcXFxcIikucmVwbGFjZSgvXCIvZywgJ1xcXFxcIicpO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVTaW5nbGVRdW90ZWQoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcoaW5wdXQpLnJlcGxhY2UoL1xcXFwvZywgXCJcXFxcXFxcXFwiKS5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIik7XG59XG4iXX0=