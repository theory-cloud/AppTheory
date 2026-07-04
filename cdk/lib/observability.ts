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
   * Optional dimension filters for alarm Metrics Insights queries.
   *
   * The runtime emits only the full AppTheory EMF dimension set, so default
   * alarms use Metrics Insights over that schema instead of service-only
   * CloudWatch metric dimensions.
   *
   * Dashboard search widgets also use the full AppTheory EMF schema.
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
export class AppTheoryObservability extends Construct {
  public readonly dashboard?: cloudwatch.Dashboard;
  public readonly requestCount: cloudwatch.IMetric;
  public readonly requestDuration: cloudwatch.IMetric;
  public readonly requestErrors: cloudwatch.IMetric;
  public readonly requestErrorsAlarm: cloudwatch.Alarm;
  public readonly requestDurationAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: AppTheoryObservabilityProps = {}) {
    super(scope, id);

    const namespace = normalized(props.metricNamespace, "AppTheory");
    const service = normalized(props.serviceName, "apptheory");
    const period = props.period ?? Duration.minutes(5);
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
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: "AppTheory Request Count",
          left: [searchMetric(namespace, service, "RequestCount", "Sum", period)],
        }),
        new cloudwatch.GraphWidget({
          title: "AppTheory Request Duration p95",
          left: [searchMetric(namespace, service, "RequestDuration", "p95", period)],
        }),
        new cloudwatch.GraphWidget({
          title: "AppTheory Request Errors",
          left: [searchMetric(namespace, service, "RequestErrors", "Sum", period)],
        }),
      );
    }
  }
}

function metricInsights(
  namespace: string,
  dimensions: Record<string, string>,
  metricName: string,
  aggregate: "MAX" | "SUM",
  period: Duration,
): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: metricInsightsQuery(namespace, dimensions, metricName, aggregate),
    label: metricName,
    period,
  });
}

function metricInsightsQuery(
  namespace: string,
  dimensions: Record<string, string>,
  metricName: string,
  aggregate: "MAX" | "SUM",
): string {
  const where = Object.entries(dimensions)
    .map(([key, value]) => `${key} = '${escapeSingleQuoted(value)}'`)
    .join(" AND ");
  return [
    `SELECT ${aggregate}(${metricName})`,
    `FROM SCHEMA("${escapeDoubleQuoted(namespace)}", service, method, path, status, tenant_id, error_code)`,
    where ? `WHERE ${where}` : "",
  ].filter(Boolean).join(" ");
}

function searchMetric(namespace: string, service: string, metricName: string, statistic: string, period: Duration): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: `SEARCH('{${namespace},service,method,path,status,tenant_id,error_code} MetricName="${metricName}" service="${service}"', '${statistic}', ${period.toSeconds()})`,
    label: metricName,
    period,
  });
}

function dimensionsMap(input: AppTheoryRequestMetricDimensions): Record<string, string> {
  const out: Record<string, string> = { service: normalized(input.service, "apptheory") };
  if (input.method !== undefined) out.method = String(input.method);
  if (input.path !== undefined) out.path = String(input.path);
  if (input.status !== undefined) out.status = String(input.status);
  if (input.tenantId !== undefined) out.tenant_id = String(input.tenantId);
  if (input.errorCode !== undefined) out.error_code = String(input.errorCode);
  return out;
}

function normalized(input: string | undefined, fallback: string): string {
  const value = String(input ?? "").trim();
  return value || fallback;
}

function escapeDoubleQuoted(input: string): string {
  return String(input).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSingleQuoted(input: string): string {
  return String(input).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
