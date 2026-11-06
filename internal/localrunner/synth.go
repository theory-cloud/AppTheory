package localrunner

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// SynthOptions controls the CDK synthesis the runner performs before it reads
// the cloud assembly.
type SynthOptions struct {
	AppDir    string
	OutputDir string
	Context   map[string]string
	Stderr    io.Writer
}

// synthRunner is the synthesis function; tests replace it to exercise the
// reload path without a CDK app.
var synthRunner = Synth

// Synth runs `cdk synth` for the app with static dummy credentials and a fixed
// account/region. It never reads an operator's AWS configuration: every AWS_*
// and CDK_* variable is removed from the child environment first.
func Synth(ctx context.Context, options SynthOptions) error {
	appDir, err := filepath.Abs(options.AppDir)
	if err != nil {
		return fmt.Errorf("resolve app directory %q: %w", options.AppDir, err)
	}
	if info, err := os.Stat(filepath.Join(appDir, "cdk.json")); err != nil || info.IsDir() {
		return fmt.Errorf("%s is not a CDK app directory (no cdk.json)", appDir)
	}
	if err := os.MkdirAll(options.OutputDir, 0o750); err != nil {
		return fmt.Errorf("create synth output directory %s: %w", options.OutputDir, err)
	}

	cdkCLI := filepath.Join(appDir, "node_modules", ".bin", "cdk")
	if info, err := os.Stat(cdkCLI); err != nil || info.IsDir() {
		return fmt.Errorf(
			"the CDK CLI is not installed in %s; run 'npm ci' in that directory first (looked for %s)",
			appDir,
			cdkCLI,
		)
	}
	argv := []string{
		cdkCLI, "synth",
		"--quiet", "--no-notices", "--no-version-reporting",
		"-o", options.OutputDir,
	}
	for _, key := range sortedKeys(options.Context) {
		argv = append(argv, "-c", key+"="+options.Context[key])
	}

	command := exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // argv is built from fixed flags and app-authored context values
	command.Dir = appDir
	command.Env = synthEnvironment()
	var output strings.Builder
	command.Stdout = &output
	if options.Stderr != nil {
		command.Stderr = io.MultiWriter(&output, options.Stderr)
	} else {
		command.Stderr = &output
	}
	if err := command.Run(); err != nil {
		return fmt.Errorf("cdk synth failed in %s: %w\n%s", appDir, err, tailLines(output.String(), 40))
	}
	if _, err := os.Stat(filepath.Join(options.OutputDir, "manifest.json")); err != nil {
		return fmt.Errorf("cdk synth produced no cloud assembly in %s: %w", options.OutputDir, err)
	}
	return nil
}

// synthEnvironment is the complete, minimal environment CDK synthesis sees.
// TS_NODE_TRANSPILE_ONLY keeps local synthesis independent of the operator's
// node_modules version skew (LOCAL-A0); the repository's synth gate owns type
// checking.
func synthEnvironment() []string {
	env := cleanEnvironment()
	return append(env,
		"AWS_REGION="+LocalRegion,
		"AWS_DEFAULT_REGION="+LocalRegion,
		"AWS_ACCESS_KEY_ID=dummy",
		"AWS_SECRET_ACCESS_KEY=dummy",
		"AWS_EC2_METADATA_DISABLED=true",
		"AWS_CONFIG_FILE="+os.DevNull,
		"AWS_SHARED_CREDENTIALS_FILE="+os.DevNull,
		"CDK_DEFAULT_ACCOUNT="+LocalAccountID,
		"CDK_DEFAULT_REGION="+LocalRegion,
		"CI=1",
		"NO_COLOR=1",
		"FORCE_COLOR=0",
		"JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1",
		"TS_NODE_TRANSPILE_ONLY=1",
	)
}

// cleanEnvironment drops every operator AWS, CDK and proxy variable. The
// runner must never inherit credentials or an endpoint that could reach AWS.
func cleanEnvironment() []string {
	var env []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "AWS_") || strings.HasPrefix(name, "CDK_") {
			continue
		}
		switch strings.ToUpper(name) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
			continue
		}
		switch name {
		case "DYNAMODB_ENDPOINT", "DDB_ENDPOINT", "TABLE_NAME", "QUEUE_URL":
			continue
		}
		env = append(env, entry)
	}
	sort.Strings(env)
	return env
}

func tailLines(value string, limit int) string {
	lines := strings.Split(strings.TrimRight(value, "\n"), "\n")
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return strings.Join(lines, "\n")
}
