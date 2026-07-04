import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
/**
 * Dimensions for AppTheory EMF request metrics.
 *
 * The runtime emits metrics in namespace `AppTheory` with metric names
 * `RequestCount`, `RequestDuration`, and `RequestErrors`. EMF dimensions are:
 * `service`, `method`, `path`, `status`, `tenant_id`, and `error_code`.
 */
export interface AppTheoryRequestMetricDimensions {
    /**
     * AppTheory service dimension.
     * @default "apptheory"
     */
    readonly service?: string;
    /**
     * HTTP method dimension.
     * @default undefined
     */
    readonly method?: string;
    /**
     * HTTP route/path dimension.
     * @default undefined
     */
    readonly path?: string;
    /**
     * HTTP status dimension.
     * @default undefined
     */
    readonly status?: string;
    /**
     * Tenant id dimension.
     * @default undefined
     */
    readonly tenantId?: string;
    /**
     * Error code dimension.
     * @default undefined
     */
    readonly errorCode?: string;
}
export interface AppTheoryObservabilityProps {
    /**
     * CloudWatch metric namespace emitted by AppTheory EMF sinks.
     * @default "AppTheory"
     */
    readonly metricNamespace?: string;
    /**
     * Service dimension emitted by the runtime.
     * @default "apptheory"
     */
    readonly serviceName?: string;
    /**
     * Optional precise dimensions for alarm metrics.
     * Dashboard search widgets always use the full AppTheory EMF schema.
     * @default { service: serviceName }
     */
    readonly alarmDimensions?: AppTheoryRequestMetricDimensions;
    /**
     * Dashboard name.
     * @default undefined
     */
    readonly dashboardName?: string;
    /**
     * Metric period.
     * @default Duration.minutes(5)
     */
    readonly period?: Duration;
    /**
     * Request error alarm threshold over the period.
     * @default 1
     */
    readonly requestErrorThreshold?: number;
    /**
     * Request duration alarm threshold in milliseconds.
     * @default 1000
     */
    readonly requestDurationThresholdMs?: number;
    /**
     * Alarm evaluation periods.
     * @default 1
     */
    readonly evaluationPeriods?: number;
    /**
     * Whether to create the dashboard.
     * @default true
     */
    readonly createDashboard?: boolean;
}
/**
 * Dashboard and alarms for AppTheory's first-party runtime metrics.
 */
export declare class AppTheoryObservability extends Construct {
    readonly dashboard?: cloudwatch.Dashboard;
    readonly requestCount: cloudwatch.IMetric;
    readonly requestDuration: cloudwatch.IMetric;
    readonly requestErrors: cloudwatch.IMetric;
    readonly requestErrorsAlarm: cloudwatch.Alarm;
    readonly requestDurationAlarm: cloudwatch.Alarm;
    constructor(scope: Construct, id: string, props?: AppTheoryObservabilityProps);
}
