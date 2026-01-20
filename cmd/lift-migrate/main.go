package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"go/format"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type change struct {
	after []byte
	path  string
}

func main() {
	os.Exit(run())
}

func run() int {
	var root string
	var apply bool

	flag.StringVar(&root, "root", ".", "root directory to scan")
	flag.BoolVar(&apply, "apply", false, "apply changes (default is dry-run)")
	flag.Parse()

	root = filepath.Clean(root)

	changes, err := collectChanges(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "lift-migrate: FAIL: %v\n", err)
		return 2
	}

	if len(changes) == 0 {
		fmt.Println("lift-migrate: no changes")
		return 0
	}

	if !apply {
		if err := printChangesDiff(root, changes); err != nil {
			fmt.Fprintf(os.Stderr, "lift-migrate: FAIL: %v\n", err)
			return 2
		}
		fmt.Fprintf(os.Stderr, "lift-migrate: %d file(s) would change (re-run with -apply)\n", len(changes))
		return 1
	}

	if err := applyChanges(changes); err != nil {
		fmt.Fprintf(os.Stderr, "lift-migrate: FAIL: %v\n", err)
		return 2
	}

	fmt.Printf("lift-migrate: updated %d file(s)\n", len(changes))
	return 0
}

func shouldSkipDir(name string) bool {
	switch name {
	case ".git", "node_modules", "dist", "vendor", ".venv":
		return true
	default:
		return false
	}
}

func collectChanges(root string) ([]change, error) {
	var changes []change

	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if entry.IsDir() {
			if shouldSkipDir(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}

		if filepath.Ext(path) != ".go" {
			return nil
		}

		//nolint:gosec // File path is discovered from walking the user-supplied root directory.
		src, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}

		out, changed, rewriteErr := rewriteGoFile(path, src)
		if rewriteErr != nil {
			return fmt.Errorf("rewrite %s: %w", path, rewriteErr)
		}
		if !changed {
			return nil
		}

		changes = append(changes, change{
			path:  path,
			after: out,
		})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}

	return changes, nil
}

func printChangesDiff(root string, changes []change) error {
	for _, ch := range changes {
		if err := printUnifiedDiff(root, ch.path, ch.after); err != nil {
			return err
		}
	}
	return nil
}

func applyChanges(changes []change) error {
	for _, ch := range changes {
		info, err := os.Stat(ch.path)
		if err != nil {
			return err
		}

		if err := os.WriteFile(ch.path, ch.after, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

func rewriteGoFile(filename string, src []byte) ([]byte, bool, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, src, parser.ParseComments)
	if err != nil {
		return nil, false, err
	}

	changed := false

	for _, spec := range file.Imports {
		if spec == nil || spec.Path == nil {
			continue
		}

		oldPath, err := strconv.Unquote(spec.Path.Value)
		if err != nil || oldPath == "" {
			continue
		}

		newPath, ok := mapImport(oldPath)
		if !ok || newPath == oldPath {
			continue
		}

		spec.Path.Value = strconv.Quote(newPath)
		changed = true
	}

	if !changed {
		return nil, false, nil
	}

	var buf bytes.Buffer
	if err := format.Node(&buf, fset, file); err != nil {
		return nil, false, err
	}

	out := buf.Bytes()
	if bytes.Equal(src, out) {
		return nil, false, nil
	}
	return out, true, nil
}

func mapImport(oldPath string) (string, bool) {
	const oldBase = "github.com/pay-theory/limited"
	const newBase = "github.com/theory-cloud/apptheory/pkg/limited"

	if oldPath == oldBase {
		return newBase, true
	}
	if strings.HasPrefix(oldPath, oldBase+"/") {
		return newBase + strings.TrimPrefix(oldPath, oldBase), true
	}

	return "", false
}

func printUnifiedDiff(root, path string, after []byte) error {
	tmp, err := os.CreateTemp("", "lift-migrate-*.go")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if err := os.Remove(tmpName); err != nil {
			fmt.Fprintf(os.Stderr, "lift-migrate: warning: cleanup temp file: %v\n", err)
		}
	}()

	if _, err := tmp.Write(after); err != nil {
		if closeErr := tmp.Close(); closeErr != nil {
			return fmt.Errorf("close temp file after write failure: %w (write error: %v)", closeErr, err)
		}
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	rel := path
	if root != "" {
		if r, err := filepath.Rel(root, path); err == nil && r != "." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			rel = r
		}
	}
	rel = filepath.ToSlash(rel)

	//nolint:gosec // `diff` is invoked with a fixed command and file paths as args (no shell).
	cmd := exec.CommandContext(context.Background(), "diff", "-u",
		"--label", "a/"+rel,
		"--label", "b/"+rel,
		path,
		tmpName,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil
		}
		return err
	}

	return nil
}
