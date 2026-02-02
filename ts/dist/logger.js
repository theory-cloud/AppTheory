import { paymentXMLPatterns, rapidConnectXMLPatterns, sanitizeFieldValue, sanitizeJSON, sanitizeLogString, sanitizeXML, } from "./sanitization.js";
class NoOpLogger {
    debug(_message, ..._fields) { }
    info(_message, ..._fields) { }
    warn(_message, ..._fields) { }
    error(_message, ..._fields) { }
    withField(_key, _value) {
        return this;
    }
    withFields(_fields) {
        return this;
    }
    withRequestID(_requestId) {
        return this;
    }
    withTenantID(_tenantId) {
        return this;
    }
    withUserID(_userId) {
        return this;
    }
    withTraceID(_traceId) {
        return this;
    }
    withSpanID(_spanId) {
        return this;
    }
    isHealthy() {
        return true;
    }
    getStats() {
        return {};
    }
}
let globalLogger = new NoOpLogger();
export function getLogger() {
    return globalLogger;
}
export function setLogger(logger) {
    globalLogger = logger ?? new NoOpLogger();
}
export { paymentXMLPatterns, rapidConnectXMLPatterns, sanitizeFieldValue, sanitizeJSON, sanitizeLogString, sanitizeXML, };
