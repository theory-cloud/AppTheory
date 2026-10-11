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
        // The CloudWatch dimension tuple is bounded to service, method, route
        // template, status class, and error code. The concrete request path, raw
        // status code, and any client-supplied tenant hint are deliberately
        // excluded: they are attacker-influenced and would let unauthenticated
        // requests mint unbounded custom metric series (and billing) for every
        // unique value. Those concrete values remain on the framework's request log
        // and span records, which carry no metric-cardinality cost; an authenticated,
        // bounded tenant identity could be added as a dimension later, but no such
        // binding is invented here.
        const envelope = {
            _aws: {
                Timestamp: this.clock().getTime(),
                CloudWatchMetrics: [
                    {
                        Namespace: this.namespace,
                        Dimensions: [
                            ["service", "method", "route", "status_class", "error_code"],
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
            route: emfRouteTemplate(tags["route"]),
            status_class: emfStatusClass(status, tags["status_class"]),
            error_code: errorCode,
            RequestCount: Math.trunc(Number(record.value ?? 0)),
            RequestDuration: nonNegativeInteger(record.durationMs),
            RequestErrors: requestErrorMetricValue(status, errorCode),
        };
        return JSON.stringify(envelope);
    }
}
const EMF_UNMATCHED_ROUTE = "unmatched";
function emfRouteTemplate(value) {
    const route = String(value ?? "").trim();
    return route || EMF_UNMATCHED_ROUTE;
}
function emfStatusClass(statusValue, classValue) {
    const explicit = String(classValue ?? "").trim();
    if (explicit)
        return explicit;
    const parsed = Number.parseInt(String(statusValue ?? "").trim(), 10);
    if (!Number.isFinite(parsed))
        return "unknown";
    if (parsed >= 100 && parsed < 200)
        return "1xx";
    if (parsed >= 200 && parsed < 300)
        return "2xx";
    if (parsed >= 300 && parsed < 400)
        return "3xx";
    if (parsed >= 400 && parsed < 500)
        return "4xx";
    if (parsed >= 500 && parsed < 600)
        return "5xx";
    return "unknown";
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