package main

import (
	"encoding/json"
	"fmt"
)

func marshalIndentOrPlaceholder(value any) []byte {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return []byte(fmt.Sprintf("<unavailable: %v>", err))
	}
	return b
}
