// Command conformance-go-init is the Go initialization-failure fixture: the
// runtime exits before its first Next API request.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "conformance-go-init: refusing to start")
	os.Exit(1)
}
