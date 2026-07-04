package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

const templateEnv = "APPTHEORY_INIT_TEMPLATE_DIR"

var appNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]*$`)

type initOptions struct {
	lang        string
	target      string
	version     string
	templateDir string
}

type renderContext struct {
	appName      string
	packageName  string
	modulePath   string
	className    string
	pythonModule string
	version      string
	tag          string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	opts, err := parseArgs(args)
	if err != nil {
		return err
	}
	return scaffold(opts)
}

func parseArgs(args []string) (initOptions, error) {
	var opts initOptions
	fs := flag.NewFlagSet("apptheory-init", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&opts.lang, "lang", "", "language to scaffold: go, ts, or py")
	fs.StringVar(&opts.version, "version", "", "AppTheory release version to pin, without the leading v")
	fs.StringVar(&opts.templateDir, "template-dir", "", "override template directory (defaults to repo templates/apptheory-init)")
	if err := fs.Parse(args); err != nil {
		return opts, err
	}
	if fs.NArg() != 1 {
		return opts, errors.New("usage: apptheory-init --lang=go|ts|py <target-dir>")
	}
	opts.target = fs.Arg(0)
	lang, err := normalizeLang(opts.lang)
	if err != nil {
		return opts, err
	}
	opts.lang = lang
	return opts, nil
}

func normalizeLang(input string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(input)) {
	case "go", "golang":
		return "go", nil
	case "ts", "typescript", "node", "nodejs":
		return "ts", nil
	case "py", "python":
		return "py", nil
	default:
		return "", errors.New("apptheory-init --lang must be one of: go, ts, py")
	}
}

func scaffold(opts initOptions) error {
	target, err := filepath.Abs(opts.target)
	if err != nil {
		return err
	}
	appName := filepath.Base(target)
	if !appNamePattern.MatchString(appName) {
		return fmt.Errorf("apptheory-init target directory name %q must start with a letter and contain only letters, digits, dot, underscore, or dash", appName)
	}
	if readyErr := ensureTargetReady(target); readyErr != nil {
		return readyErr
	}
	templateRoot, err := resolveTemplateRoot(opts.templateDir)
	if err != nil {
		return err
	}
	version := cleanVersion(opts.version)
	if version == "" {
		version, err = inferVersion(templateRoot)
		if err != nil {
			return err
		}
	}
	ctx := renderContext{
		appName:      appName,
		packageName:  kebab(appName),
		modulePath:   "example.com/" + kebab(appName),
		className:    pascal(appName),
		pythonModule: snake(appName),
		version:      version,
		tag:          "v" + version,
	}
	langRoot := filepath.Join(templateRoot, opts.lang)
	if st, err := os.Stat(langRoot); err != nil || !st.IsDir() {
		return fmt.Errorf("apptheory-init missing template for language %q under %s", opts.lang, templateRoot)
	}
	if err := copyTemplateTree(langRoot, target, ctx); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(os.Stdout, "created %s AppTheory project at %s pinned to %s\n", opts.lang, target, ctx.tag); err != nil {
		return err
	}
	return nil
}

func ensureTargetReady(target string) error {
	entries, err := os.ReadDir(target)
	if err == nil {
		if len(entries) > 0 {
			return fmt.Errorf("apptheory-init target %s already exists and is not empty", target)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.MkdirAll(target, 0o750)
}

func resolveTemplateRoot(explicit string) (string, error) {
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	}
	if env := os.Getenv(templateEnv); env != "" {
		candidates = append(candidates, env)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, ascendForTemplateRoot(cwd)...)
	}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, ascendForTemplateRoot(filepath.Dir(exe))...)
	}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil || seen[abs] {
			continue
		}
		seen[abs] = true
		if st, err := os.Stat(abs); err == nil && st.IsDir() {
			if hasLanguageTemplates(abs) {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("apptheory-init could not find templates/apptheory-init; run from the AppTheory repo or set %s", templateEnv)
}

func ascendForTemplateRoot(start string) []string {
	var out []string
	dir := filepath.Clean(start)
	for {
		out = append(out, filepath.Join(dir, "templates", "apptheory-init"))
		parent := filepath.Dir(dir)
		if parent == dir {
			return out
		}
		dir = parent
	}
}

func hasLanguageTemplates(root string) bool {
	for _, lang := range []string{"go", "ts", "py"} {
		if st, err := os.Stat(filepath.Join(root, lang)); err != nil || !st.IsDir() {
			return false
		}
	}
	return true
}

func inferVersion(templateRoot string) (string, error) {
	candidates := []string{
		filepath.Join(filepath.Dir(filepath.Dir(templateRoot)), "VERSION"),
	}
	if cwd, err := os.Getwd(); err == nil {
		dir := filepath.Clean(cwd)
		for {
			candidates = append(candidates, filepath.Join(dir, "VERSION"))
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	for _, candidate := range candidates {
		b, err := os.ReadFile(candidate) //nolint:gosec // VERSION candidates come from repo-root discovery for this local scaffolder.
		if err == nil {
			version := cleanVersion(string(b))
			if version != "" {
				return version, nil
			}
		}
	}
	return "", errors.New("apptheory-init could not infer AppTheory VERSION; pass --version")
}

func cleanVersion(input string) string {
	line := strings.TrimSpace(strings.SplitN(input, "#", 2)[0])
	return strings.TrimPrefix(line, "v")
}

func copyTemplateTree(srcRoot string, destRoot string, ctx renderContext) error {
	var dirs []string
	var files []string
	if err := filepath.WalkDir(srcRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == srcRoot {
			return nil
		}
		rel, err := filepath.Rel(srcRoot, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, rel)
			return nil
		}
		if d.Type().IsRegular() {
			files = append(files, rel)
		}
		return nil
	}); err != nil {
		return err
	}
	sort.Strings(dirs)
	sort.Strings(files)
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(destRoot, renderPath(dir, ctx)), 0o750); err != nil {
			return err
		}
	}
	for _, file := range files {
		in := filepath.Join(srcRoot, file)
		outRel := renderPath(strings.TrimSuffix(file, ".tmpl"), ctx)
		out := filepath.Join(destRoot, outRel)
		if err := os.MkdirAll(filepath.Dir(out), 0o750); err != nil {
			return err
		}
		b, err := os.ReadFile(in) //nolint:gosec // template paths are bounded by the resolved templates/apptheory-init tree.
		if err != nil {
			return err
		}
		content := renderString(string(b), ctx)
		mode := fs.FileMode(0o644)
		if strings.HasPrefix(filepath.Base(out), "bootstrap") || strings.HasSuffix(out, ".sh") {
			mode = 0o755
		}
		if err := os.WriteFile(out, []byte(content), mode); err != nil {
			return err
		}
	}
	return nil
}

func renderPath(path string, ctx renderContext) string {
	return renderString(path, ctx)
}

func renderString(input string, ctx renderContext) string {
	replacements := map[string]string{
		"__APP_NAME__":          ctx.appName,
		"__APP_PACKAGE__":       ctx.packageName,
		"__APP_MODULE__":        ctx.modulePath,
		"__APP_CLASS__":         ctx.className,
		"__APP_PY_MODULE__":     ctx.pythonModule,
		"__APPTHEORY_VERSION__": ctx.version,
		"__APPTHEORY_TAG__":     ctx.tag,
	}
	out := input
	for old, new := range replacements {
		out = strings.ReplaceAll(out, old, new)
	}
	return out
}

func kebab(input string) string {
	return strings.Trim(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return '-'
	}, input), "-")
}

func snake(input string) string {
	out := strings.Trim(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return '_'
	}, input), "_")
	if out == "" {
		return "app"
	}
	return out
}

func pascal(input string) string {
	parts := regexp.MustCompile(`[^A-Za-z0-9]+`).Split(input, -1)
	var b strings.Builder
	for _, part := range parts {
		if part == "" {
			continue
		}
		runes := []rune(part)
		b.WriteRune(unicode.ToUpper(runes[0]))
		for _, r := range runes[1:] {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "App"
	}
	return b.String()
}
