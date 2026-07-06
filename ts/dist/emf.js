const DEFAULT_EMF_NAMESPACE = "AppTheory";
const DEFAULT_EMF_SERVICE = "apptheory";
export class EMFMetricSink {
    namespace;
    service;
    writeLine;
    clock;
    constructor(options = {}) {
        const namespace = String(options.namespace ?? "").trim();
        const service = String(options.service ?? "").trim();
        this.namespace = namespace || DEFAULT_EMF_NAMESPACE;
        this.service = service || DEFAULT_EMF_SERVICE;
        this.writeLine =
            typeof options.write === "function"
                ? options.write
                : (line) => {
                    process.stdout.write(`${line}\n`);
                };
        this.clock = options.clock ?? (() => new Date());
    }
    recordMetric(record) {
        if (String(record.name ?? "").trim() !== "apptheory.request")
            return;
        this.writeLine(this.encodeMetric(record));
    }
    encodeMetric(record) {
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
export function createEMFMetricSink(options = {}) {
    return new EMFMetricSink(options);
}
export function hooksFromEMFMetricSink(sink) {
    if (!sink)
        return {};
    return { metric: (record) => sink.recordMetric(record) };
}
function nonNegativeInteger(value) {
    const parsed = Math.trunc(Number(value ?? 0));
    return parsed > 0 ? parsed : 0;
}
function requestErrorMetricValue(status, errorCode) {
    if (errorCode.trim())
        return 1;
    const parsed = Number.parseInt(status.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 400 ? 1 : 0;
}
//# sourceMappingURL=emf.js.map