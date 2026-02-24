package mcp

import "strings"

func isNotFound(err error, prefix string) bool {
	if err == nil {
		return false
	}
	return strings.HasPrefix(err.Error(), prefix)
}
