package store_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// negativeVersionCallPattern matches a store call that passes a negative integer
// literal for its expected version, for example `CompareAndSwap(ctx, record, -1)`.
var negativeVersionCallPattern = regexp.MustCompile(`\.(CompareAndSwap|AcquireLock|Update)\([^)]*,[[:space:]]*-\d`)

// TestCallersNeverPassANegativeExpectedVersion pins a caller contract shared by
// the broker and client stores: the expected version is the version the caller
// read, and a negative value reports a version conflict rather than acting as a
// skip-version-check wildcard. Facade code that passed one would silently rely
// on behavior no runtime implements, so this scans the runtime tree — the facade
// and oauth packages as well as the stores — for a store call with a negative
// literal argument.
func TestCallersNeverPassANegativeExpectedVersion(t *testing.T) {
	root := filepath.Join("..", "..")
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		//nolint:gosec // The path comes from walking the repository's own runtime tree.
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if match := negativeVersionCallPattern.Find(raw); match != nil {
			t.Errorf("store call with a negative expected version in %s: %s", path, match)
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("scan runtime tree: %v", walkErr)
	}
}
