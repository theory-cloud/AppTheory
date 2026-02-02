package logger

import (
	"sync"

	"github.com/theory-cloud/apptheory/pkg/observability"
	"github.com/theory-cloud/apptheory/pkg/sanitization"
)

var (
	globalMu     sync.RWMutex
	globalLogger observability.StructuredLogger = observability.NewNoOpLogger()
)

// Logger returns the global structured logger singleton.
func Logger() observability.StructuredLogger {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return globalLogger
}

// SetLogger replaces the global structured logger singleton.
//
// Passing nil resets the logger to a no-op implementation.
func SetLogger(next observability.StructuredLogger) {
	globalMu.Lock()
	defer globalMu.Unlock()
	if next == nil {
		globalLogger = observability.NewNoOpLogger()
		return
	}
	globalLogger = next
}

// SanitizeLogString removes control characters that could enable log forging.
func SanitizeLogString(value string) string {
	return sanitization.SanitizeLogString(value)
}

// SanitizeFieldValue applies deterministic redaction rules to a field value.
func SanitizeFieldValue(key string, value any) any {
	return sanitization.SanitizeFieldValue(key, value)
}

// SanitizeJSON returns a sanitized JSON string for safe logging.
func SanitizeJSON(jsonBytes []byte) string {
	return sanitization.SanitizeJSON(jsonBytes)
}

// SanitizeXML masks sensitive data in XML using the provided patterns.
func SanitizeXML(xmlString string, patterns []sanitization.XMLSanitizationPattern) string {
	return sanitization.SanitizeXML(xmlString, patterns)
}

// PaymentXMLPatterns are pre-configured XML patterns for payment payloads.
var PaymentXMLPatterns = sanitization.PaymentXMLPatterns

// RapidConnectXMLPatterns are aliases for PaymentXMLPatterns.
var RapidConnectXMLPatterns = sanitization.RapidConnectXMLPatterns
