import {
  paymentXMLPatterns,
  rapidConnectXMLPatterns,
  sanitizeFieldValue,
  sanitizeJSON,
  sanitizeLogString,
  sanitizeXML,
} from "./sanitization.js";

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

class NoOpLogger implements StructuredLogger {
  debug(_message: string, ..._fields: LogFields[]): void {}
  info(_message: string, ..._fields: LogFields[]): void {}
  warn(_message: string, ..._fields: LogFields[]): void {}
  error(_message: string, ..._fields: LogFields[]): void {}

  withField(_key: string, _value: unknown): StructuredLogger {
    return this;
  }

  withFields(_fields: LogFields): StructuredLogger {
    return this;
  }

  withRequestID(_requestId: string): StructuredLogger {
    return this;
  }

  withTenantID(_tenantId: string): StructuredLogger {
    return this;
  }

  withUserID(_userId: string): StructuredLogger {
    return this;
  }

  withTraceID(_traceId: string): StructuredLogger {
    return this;
  }

  withSpanID(_spanId: string): StructuredLogger {
    return this;
  }

  isHealthy(): boolean {
    return true;
  }

  getStats(): LogFields {
    return {};
  }
}

let globalLogger: StructuredLogger = new NoOpLogger();

export function getLogger(): StructuredLogger {
  return globalLogger;
}

export function setLogger(logger: StructuredLogger | null | undefined): void {
  globalLogger = logger ?? new NoOpLogger();
}

export {
  paymentXMLPatterns,
  rapidConnectXMLPatterns,
  sanitizeFieldValue,
  sanitizeJSON,
  sanitizeLogString,
  sanitizeXML,
};
