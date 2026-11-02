// Command apptheory-local runs an AppTheory app's real Lambda handlers on this
// machine. The app's existing CDK definition is the only routing source: the
// command synthesizes the app, reads the cloud assembly, starts each served
// function in the official Lambda runtime image (digest-pinned, with its
// embedded Runtime Interface Emulator) and serves the derived HTTP API v2, REST
// API v1 and Function URL surfaces.
//
// Usage:
//
//	apptheory-local run  --app <cdk-app-dir> [flags]
//	apptheory-local plan --app <cdk-app-dir> [flags]
//	apptheory-local down --app <cdk-app-dir> [flags]
//
// `run` is the default when no subcommand is given. Every flag is a command
// line flag; the runner reads no operator environment variable.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"

	"github.com/theory-cloud/apptheory/v6/internal/localrunner"
)

const usageText = `apptheory-local runs an AppTheory app's real Lambda handlers locally.

Usage:
  apptheory-local [run] --app <cdk-app-dir> [flags]   serve the app locally
  apptheory-local plan  --app <cdk-app-dir> [flags]   synthesize and print the derived surface
  apptheory-local down  --app <cdk-app-dir> [flags]   remove this app's leftover containers and networks

Flags:
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	command := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "run", "plan", "down":
	case "help", "-h", "--help":
		fmt.Print(usageText)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "apptheory-local: unknown command %q\n\n%s", command, usageText)
		return 2
	}

	config := &commandConfig{}
	flags := flag.NewFlagSet("apptheory-local "+command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.Usage = func() {
		fmt.Print(usageText)
		flags.PrintDefaults()
	}
	config.register(flags)
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(config.app) == "" {
		fmt.Fprintln(os.Stderr, "apptheory-local: --app is required")
		return 2
	}
	return config.execute(command)
}

type commandConfig struct {
	app            string
	assemblyDir    string
	scratchDir     string
	profilePath    string
	portBase       int
	namePrefix     string
	maxConcurrency int
	jsonOutput     bool
	contexts       stringList
	images         stringList
	endpoints      stringList
	addHosts       stringList
	backends       stringList
}

func (c *commandConfig) register(flags *flag.FlagSet) {
	flags.StringVar(&c.app, "app", "", "CDK app directory (contains cdk.json)")
	flags.StringVar(&c.assemblyDir, "assembly", "", "read an existing cloud assembly instead of running cdk synth")
	flags.StringVar(&c.scratchDir, "scratch", "", "scratch directory for synthesis and inline code (default: the user cache directory)")
	flags.StringVar(&c.profilePath, "profile", "", "checked-in local execution profile with digest-pinned runtime images and endpoints")
	flags.IntVar(&c.portBase, "port-base", 0, "bind API listeners at this port; 0 asks the OS for free ports")
	flags.StringVar(&c.namePrefix, "name-prefix", "", "container and network name prefix (default: derived from the app path)")
	flags.IntVar(&c.maxConcurrency, "max-concurrency", 32, "maximum in-flight invocations (1-32)")
	flags.BoolVar(&c.jsonOutput, "json", false, "plan: print the derived surface as JSON")
	flags.Var(&c.contexts, "c", "CDK context key=value (repeatable)")
	flags.Var(&c.contexts, "context", "CDK context key=value (repeatable)")
	flags.Var(&c.images, "image", "runtime image override class=tag@sha256:... (repeatable)")
	flags.Var(&c.endpoints, "endpoint", "local AWS endpoint service=url (repeatable)")
	flags.Var(&c.addHosts, "add-host", "extra /etc/hosts entry name=address for function containers (repeatable)")
	flags.Var(&c.backends, "backend", "local emulator the runner starts on the run network: dynamodb (repeatable)")
}

func (c *commandConfig) execute(command string) int {
	options, err := c.options()
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 2
	}
	if c.jsonOutput {
		// Machine output owns stdout; synthesis progress goes to stderr.
		options.Stdout = os.Stderr
	}
	runner, err := localrunner.NewRunner(options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch command {
	case "plan":
		return c.plan(ctx, runner)
	case "down":
		return c.down(ctx, runner)
	default:
		return c.serve(ctx, runner)
	}
}

func (c *commandConfig) plan(ctx context.Context, runner *localrunner.Runner) int {
	defer runner.CleanScratch()
	spec, err := runner.Plan(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	if c.jsonOutput {
		document, err := runner.PlanJSON(spec)
		if err != nil {
			fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
			return 1
		}
		fmt.Println(string(document))
		return 0
	}
	fmt.Printf("app:      %s\n", c.app)
	fmt.Printf("assembly: %s\n", spec.AssemblyDir)
	fmt.Println()
	fmt.Println("functions:")
	for _, function := range spec.Functions {
		fmt.Printf("  %-40s %-16s %-8s %s\n",
			function.LogicalID, function.Runtime, function.Architecture, memoryCell(function))
	}
	fmt.Println()
	fmt.Println("routes:")
	for _, line := range localrunner.RouteTable(spec) {
		fmt.Printf("  %s\n", line)
	}
	if len(spec.Skipped) > 0 {
		fmt.Println()
		fmt.Println("not served locally:")
		for _, skipped := range spec.Skipped {
			fmt.Printf("  %-40s %s\n", skipped.LogicalID, skipped.Reason)
		}
	}
	return 0
}

// memoryCell renders a function's memory for the plan. An unresolved intrinsic
// is shown as such instead of the internal fallback, so plan never reports a
// default that the runner would refuse to apply to a served function.
func memoryCell(function localrunner.FunctionSpec) string {
	if function.UnresolvedMemorySize {
		if function.MemorySizeExpression != "" {
			return "unresolved (" + function.MemorySizeExpression + ")"
		}
		return "unresolved"
	}
	return fmt.Sprintf("%4d MB", function.MemoryMB)
}

func (c *commandConfig) serve(ctx context.Context, runner *localrunner.Runner) int {
	fmt.Printf("apptheory-local: %s\n", c.app)
	if err := runner.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	return 0
}

func (c *commandConfig) down(ctx context.Context, runner *localrunner.Runner) int {
	removed, err := runner.Down(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	fmt.Printf("apptheory-local: removed %d container(s) and network(s)\n", removed)
	return 0
}

func (c *commandConfig) options() (localrunner.Options, error) {
	contexts, err := splitPairList(c.contexts, "context")
	if err != nil {
		return localrunner.Options{}, err
	}
	images, err := splitPairList(c.images, "image")
	if err != nil {
		return localrunner.Options{}, err
	}
	endpoints, err := c.endpointList()
	if err != nil {
		return localrunner.Options{}, err
	}
	if _, err := splitPairList(c.addHosts, "add-host"); err != nil {
		return localrunner.Options{}, err
	}
	return localrunner.Options{
		AppDir:         c.app,
		Context:        contexts,
		AssemblyDir:    c.assemblyDir,
		ScratchDir:     c.scratchDir,
		ProfilePath:    c.profilePath,
		Images:         images,
		Endpoints:      endpoints,
		AddHosts:       c.addHosts,
		Backends:       c.backends,
		PortBase:       c.portBase,
		NamePrefix:     c.namePrefix,
		MaxConcurrency: c.maxConcurrency,
		Stdout:         os.Stdout,
	}, nil
}

func (c *commandConfig) endpointList() ([]localrunner.Endpoint, error) {
	var endpoints []localrunner.Endpoint
	for _, entry := range c.endpoints {
		service, value, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(service) == "" || strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("--endpoint %q must be service=url", entry)
		}
		endpoints = append(endpoints, localrunner.Endpoint{
			Service: strings.ToLower(strings.TrimSpace(service)),
			URL:     strings.TrimSpace(value),
		})
	}
	sort.Slice(endpoints, func(i, j int) bool { return endpoints[i].Service < endpoints[j].Service })
	return endpoints, nil
}

func splitPairList(values []string, name string) (map[string]string, error) {
	out := make(map[string]string, len(values))
	for _, entry := range values {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("--%s %q must be key=value", name, entry)
		}
		out[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return out, nil
}

type stringList []string

func (l *stringList) String() string {
	return strings.Join(*l, ",")
}

func (l *stringList) Set(value string) error {
	*l = append(*l, value)
	return nil
}
