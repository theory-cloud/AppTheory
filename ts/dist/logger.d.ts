import { paymentXMLPatterns, rapidConnectXMLPatterns, sanitizeFieldValue, sanitizeJSON, sanitizeLogString, sanitizeXML } from "./sanitization.js";
export type LogFields = Record<string, unknown>;
export interface StructuredLogger {
    debug(message: string, ...fields: LogFields[]): void;
    info(message: string, ...fields: LogFields[]): void;
    warn(message: string, ...fields: LogFields[]): void;
    error(message: string, ...fields: LogFields[]): void;
    withField(key: string, value: unknown): StructuredLogger;
    withFields(fields: LogFields): StructuredLogger;
    withRequestID(requestId: string): StructuredLogger;
    withTenantID(tenantId: string): StructuredLogger;
    withUserID(userId: string): StructuredLogger;
    withTraceID(traceId: string): StructuredLogger;
    withSpanID(spanId: string): StructuredLogger;
    flush?(): void | Promise<void>;
    close?(): void | Promise<void>;
    isHealthy?(): boolean;
    getStats?(): LogFields;
}
export declare function getLogger(): StructuredLogger;
export declare function setLogger(logger: StructuredLogger | null | undefined): void;
export { paymentXMLPatterns, rapidConnectXMLPatterns, sanitizeFieldValue, sanitizeJSON, sanitizeLogString, sanitizeXML, };
