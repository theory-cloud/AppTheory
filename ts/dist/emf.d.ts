import type { MetricRecord, ObservabilityHooks } from "./app.js";
export interface EMFMetricSinkOptions {
    namespace?: string;
    service?: string;
    write?: (line: string) => void;
    clock?: () => Date;
}
export declare class EMFMetricSink {
    private readonly namespace;
    private readonly service;
    private readonly writeLine;
    private readonly clock;
    constructor(options?: EMFMetricSinkOptions);
    recordMetric(record: MetricRecord): void;
    encodeMetric(record: MetricRecord): string;
}
export declare function createEMFMetricSink(options?: EMFMetricSinkOptions): EMFMetricSink;
export declare function hooksFromEMFMetricSink(sink: EMFMetricSink | null | undefined): ObservabilityHooks;
//# sourceMappingURL=emf.d.ts.map