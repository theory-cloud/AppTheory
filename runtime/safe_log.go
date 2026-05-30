package apptheory

import (
	"strings"
	"unicode"
)

const logSafeHex = "0123456789ABCDEF"

func logSafeValue(value string) string {
	if value == "" {
		return ""
	}

	var out strings.Builder
	for _, r := range value {
		if !isUnsafeLogValueRune(r) {
			out.WriteRune(r)
			continue
		}
		for _, b := range []byte(string(r)) {
			out.WriteByte('%')
			out.WriteByte(logSafeHex[b>>4])
			out.WriteByte(logSafeHex[b&0x0f])
		}
	}
	return out.String()
}

func isUnsafeLogValueRune(r rune) bool {
	return r == '%' || r == '=' || unicode.IsSpace(r) || unicode.IsControl(r)
}
