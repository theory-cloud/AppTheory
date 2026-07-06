import type { MetricRecord, ObservabilityHooks } from "./app.js";

const DEFAULT_EMF_NAMESPACE = "AppTheory";
const DEFAULT_EMF_SERVICE = "apptheory";

export interface EMFMetricSinkOptions {
  namespace?: string;
  service?: string;
  write?: (line: string) => void;
  clock?: () => Date;
}

export class EMFMetricSink {
  private readonly namespace: string;
  private readonly service: string;
  private readonly writeLine: (line: string) => void;
  private readonly clock: () => Date;

  constructor(options: EMFMetricSinkOptions = {}) {
    const namespace = String(options.namespace ?? "").trim();
    const service = String(options.service ?? "").trim();
    this.namespace = namespace || DEFAULT_EMF_NAMESPACE;
    this.service = service || DEFAULT_EMF_SERVICE;
    this.writeLine =
      typeof options.write === "function"
        ? options.write
        : (line: string) => {
            process.stdout.write(`${line}\n`);
          };
    this.clock = options.clock ?? (() => new Date());
  }

  recordMetric(record: MetricRecord): void {
    if (String(record.name ?? "").trim() !== "apptheory.request") return;
    this.writeLine(this.encodeMetric(record));
  }

  encodeMetric(record: MetricRecord): string {
    const tags = record.tags ?? {};
    const status = String(tags["status"] ?? "").trim();
    const errorCode = String(tags["error_code"] ?? "").trim();
    const envelope = {
      _aws: {
        Timestamp: this.clock().getTime(),
        CloudWatchMetrics: [
          {
            Namespace: this.namespace,
            Dimensions: [
              [
                "service",
                "method",
                "path",
                "status",
                "tenant_id",
                "error_code",
              ],
            ],
            Metrics: [
              { Name: "RequestCount", Unit: "Count" },
              { Name: "RequestDuration", Unit: "Milliseconds" },
              { Name: "RequestErrors", Unit: "Count" },
            ],
          },
        ],
      },
      service: this.service,
      method: String(tags["method"] ?? "").trim(),
      path: String(tags["path"] ?? "").trim(),
      status,
      tenant_id: String(tags["tenant_id"] ?? "").trim(),
      error_code: errorCode,
      RequestCount: Math.trunc(Number(record.value ?? 0)),
      RequestDuration: nonNegativeInteger(record.durationMs),
      RequestErrors: requestErrorMetricValue(status, errorCode),
    };
    return JSON.stringify(envelope);
  }
}

export function createEMFMetricSink(
  options: EMFMetricSinkOptions = {},
): EMFMetricSink {
  return new EMFMetricSink(options);
}

export function hooksFromEMFMetricSink(
  sink: EMFMetricSink | null | undefined,
): ObservabilityHooks {
  if (!sink) return {};
  return { metric: (record) => sink.recordMetric(record) };
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Math.trunc(Number(value ?? 0));
  return parsed > 0 ? parsed : 0;
}

function requestErrorMetricValue(status: string, errorCode: string): number {
  if (errorCode.trim()) return 1;
  const parsed = Number.parseInt(status.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 400 ? 1 : 0;
}
