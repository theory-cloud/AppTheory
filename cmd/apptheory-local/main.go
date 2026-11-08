// Command apptheory-local runs an AppTheory app's real Lambda handlers on this
// machine. The app's existing CDK definition is the only routing source: the
// command synthesizes the app, reads the cloud assembly, starts each served
// function in the official Lambda runtime image (digest-pinned) against the
// runner's own Lambda Runtime API, and serves the derived HTTP API v2, REST API
// v1, Function URL and CloudFront surfaces.
//
// Usage:
//
//	apptheory-local run    --app <cdk-app-dir> [flags]
//	apptheory-local plan   --app <cdk-app-dir> [flags]
//	apptheory-local invoke --app <cdk-app-dir> --function <id> --event <file> [flags]
//	apptheory-local invoke --handler-dir <dir> --runtime <runtime> --handler <name> [flags]
//	apptheory-local session --app <cdk-app-dir> [flags]
//	apptheory-local down   --app <cdk-app-dir> [flags]
//
// `run` is the default when no subcommand is given. Every flag is a command
// line flag; the runner reads no operator environment variable. Function
// containers talk to the runner's Lambda Runtime API; --rie runs them under the
// image's embedded Runtime Interface Emulator instead.
package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"

	"github.com/theory-cloud/apptheory/v7/internal/localrunner"
)

const usageText = `apptheory-local runs an AppTheory app's real Lambda handlers locally.

Usage:
  apptheory-local [run]  --app <cdk-app-dir> [flags]   serve the app locally
  apptheory-local plan   --app <cdk-app-dir> [flags]   synthesize and print the derived surface
  apptheory-local invoke --app <cdk-app-dir> --function <id> --event <file> [flags]
  apptheory-local invoke --handler-dir <dir> --runtime <runtime> --handler <name> [flags]
  apptheory-local session --app <cdk-app-dir> [flags]   run every target with a JSON command channel on stdin/stdout
  apptheory-local down   --app <cdk-app-dir> [flags]   remove this app's leftover containers and networks
  apptheory-local tls ca   --data-dir <dir>            create or report the local CA the --tls opt-in uses
  apptheory-local tls leaf --data-dir <dir> --name <host> --out <dir>
                                                       issue an auxiliary service's certificate from that CA

Invoke sends a Lambda event to one warm function container and prints one JSON
result per event. Use --stdio to read newline-delimited events from stdin, which
keeps the container warm across requests. Handler mode is for examples that
ship a handler but no CDK definition; it derives no routes.

Flags:
`

func main() {
	os.Exit(run(os.Args[1:]))
}

//nolint:gocyclo // the command switch is explicit.
func run(args []string) int {
	command := commandRun
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case commandRun, "plan", commandInvoke, commandSession, "down", "tls":
	case "help", "-h", "--help":
		fmt.Print(usageText)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "apptheory-local: unknown command %q\n\n%s", command, usageText)
		return 2
	}
	if command == "tls" {
		return runTLSCommand(args)
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
	if config.watch && command != commandRun && command != commandSession {
		fmt.Fprintln(os.Stderr, "apptheory-local: --watch is only valid on run and session")
		return 2
	}
	if config.seed != "" && command != commandRun && command != commandSession {
		fmt.Fprintln(os.Stderr, "apptheory-local: --seed is only valid on run and session")
		return 2
	}
	if config.dataDir != "" && command != commandRun && command != commandSession && command != commandInvoke {
		fmt.Fprintln(os.Stderr, "apptheory-local: --data-dir is only valid on run, session and invoke")
		return 2
	}
	if (config.tls || config.tlsHost != "" || len(config.tlsAux) > 0) &&
		command != commandRun && command != commandSession {
		fmt.Fprintln(os.Stderr, "apptheory-local: --tls, --tls-host and --tls-aux are only valid on run and session")
		return 2
	}
	if command == commandInvoke {
		if err := validateInvokeConfig(config); err != nil {
			fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
			return 2
		}
	} else if strings.TrimSpace(config.app) == "" {
		fmt.Fprintln(os.Stderr, "apptheory-local: --app is required")
		return 2
	}
	return config.execute(command)
}

const (
	commandRun     = "run"
	commandInvoke  = "invoke"
	commandSession = "session"
)

func validateInvokeConfig(config *commandConfig) error {
	if strings.TrimSpace(config.app) == "" && strings.TrimSpace(config.handlerDir) == "" {
		return errors.New("invoke needs --app or --handler-dir")
	}
	if strings.TrimSpace(config.app) != "" && strings.TrimSpace(config.function) == "" {
		return errors.New("invoke --app needs --function")
	}
	if strings.TrimSpace(config.handlerDir) != "" {
		if strings.TrimSpace(config.runtime) == "" || strings.TrimSpace(config.handler) == "" {
			return errors.New("invoke --handler-dir needs --runtime and --handler")
		}
	}
	if !config.stdio && len(config.events) == 0 {
		return errors.New("invoke needs --event or --stdio")
	}
	return nil
}

type commandConfig struct {
	app                 string
	assemblyDir         string
	scratchDir          string
	profilePath         string
	portBase            int
	ports               stringList
	namePrefix          string
	maxConcurrency      int
	deliveryConcurrency int
	clock               string
	jsonOutput          bool
	allowNoSurface      bool
	contexts            stringList
	images              stringList
	endpoints           stringList
	origins             stringList
	viewerCountry       string
	addHosts            stringList
	backends            stringList
	function            string
	events              stringList
	stdio               bool
	rieMode             bool
	streamChunks        bool
	sessionTargets      stringList
	handlerDir          string
	runtime             string
	handler             string
	architecture        string
	memoryMB            int
	timeoutSeconds      int
	watch               bool
	dataDir             string
	sharedDir           string
	seed                string
	tls                 bool
	tlsHost             string
	tlsAux              stringList
}

func (c *commandConfig) register(flags *flag.FlagSet) {
	flags.StringVar(&c.app, "app", "", "CDK app directory (contains cdk.json)")
	flags.StringVar(&c.assemblyDir, "assembly", "", "read an existing cloud assembly instead of running cdk synth")
	flags.StringVar(&c.scratchDir, "scratch", "", "scratch directory for synthesis and inline code (default: the user cache directory)")
	flags.StringVar(&c.profilePath, "profile", "", "checked-in local execution profile with digest-pinned runtime images and endpoints")
	flags.IntVar(&c.portBase, "port-base", 0, "bind API listeners at this port; 0 asks the OS for free ports")
	flags.Var(&c.ports, "port", "run/session/plan: pin a public surface to a port: <logicalId>=<port> (repeatable; needs --port-base)")
	flags.StringVar(&c.namePrefix, "name-prefix", "", "container and network name prefix (default: derived from the app path)")
	flags.IntVar(&c.maxConcurrency, "max-concurrency", 32, "maximum in-flight invocations (1-32)")
	flags.IntVar(&c.deliveryConcurrency, "delivery-concurrency", 0, "maximum concurrent delivery-engine invocations (default 4, max 32)")
	flags.StringVar(&c.clock, "clock", "real", "time source for run and session: real, test, or test=<RFC3339 start>")
	flags.BoolVar(&c.jsonOutput, "json", false, "plan: print the derived surface as JSON")
	flags.BoolVar(&c.allowNoSurface, "allow-no-surface", false, "plan/session: allow an app whose functions have no served HTTP, event or rule surface")
	flags.Var(&c.contexts, "c", "CDK context key=value (repeatable)")
	flags.Var(&c.contexts, "context", "CDK context key=value (repeatable)")
	flags.Var(&c.images, "image", "runtime image override class=tag@sha256:... (repeatable)")
	flags.Var(&c.endpoints, "endpoint", "local AWS endpoint service=url (repeatable)")
	flags.Var(&c.origins, "origin", "map an external CloudFront custom origin domain to a loopback URL: domain=url (repeatable)")
	flags.StringVar(&c.viewerCountry, "viewer-country", "", "CloudFront geo restriction: the viewer's ISO 3166-1 alpha-2 country (for example US); omit for an undetermined location")
	flags.Var(&c.addHosts, "add-host", "extra /etc/hosts entry name=address for function containers (repeatable)")
	flags.Var(&c.backends, "backend", "local emulator the runner starts on the run network: dynamodb, or a profile container such as moto or s3proxy (repeatable)")
	flags.StringVar(&c.function, "function", "", "invoke: function logical id from the CDK assembly")
	flags.Var(&c.events, "event", "invoke: JSON event file (repeatable)")
	flags.BoolVar(&c.stdio, "stdio", false, "invoke: read newline-delimited JSON events from stdin and keep the container warm")
	flags.BoolVar(&c.rieMode, "rie", false, "run functions under the image's embedded Runtime Interface Emulator instead of the runner's Lambda Runtime API (buffered: responses are not streamed incrementally)")
	flags.BoolVar(&c.streamChunks, "stream-chunks", false, "invoke --stdio: write one chunk event per streamed response chunk before the result line")
	flags.Var(&c.sessionTargets, "target", "session: start this CDK function too, even with no route, event source or rule (repeatable)")
	flags.StringVar(&c.handlerDir, "handler-dir", "", "invoke: built handler code directory (no CDK app)")
	flags.StringVar(&c.runtime, "runtime", "", "invoke --handler-dir: Lambda runtime (provided.al2023, nodejs24.x, python3.14)")
	flags.StringVar(&c.handler, "handler", "", "invoke --handler-dir: handler name (bootstrap for a provided runtime)")
	flags.StringVar(&c.architecture, "architecture", "", "invoke --handler-dir: built architecture (default arm64 for provided, x86_64 otherwise)")
	flags.IntVar(&c.memoryMB, "memory", 0, "invoke --handler-dir: memory in MB (default 128)")
	flags.IntVar(&c.timeoutSeconds, "timeout", 0, "invoke --handler-dir: function timeout in seconds (default 3)")
	flags.BoolVar(&c.watch, "watch", false, "run/session: re-synthesize when the app's sources change and apply the new surface without restarting the listeners")
	flags.StringVar(&c.dataDir, "data-dir", "", "run/session/invoke: keep backend state across runs (DynamoDB Local, s3proxy, ElasticMQ, and the runner's <data-dir>/kms/keys.json and <data-dir>/s3sse/index.json; moto stays in memory)")
	flags.StringVar(&c.sharedDir, "shared-dir", "", "run/session/invoke: the directory co-resident runs share; it holds the local IAM plane at <shared-dir>/iam, and the co-residence work adds the shared CA beside it")
	flags.StringVar(&c.seed, "seed", "", "run/session: shell command to run after provisioning and before the run reports ready")
	flags.BoolVar(&c.tls, "tls", false, "run/session: serve every public listener over HTTPS from a certificate the runner's local CA signs (default off: plain HTTP, unchanged)")
	flags.StringVar(&c.tlsHost, "tls-host", "", "run/session with --tls: the public host name (localhost or a *.localhost name; default app.localhost)")
	flags.Var(&c.tlsAux, "tls-aux", "run/session with --tls: an auxiliary *.localhost name a function container must resolve to the runner (repeatable; issue its certificate with `apptheory-local tls leaf`)")
}

func (c *commandConfig) execute(command string) int {
	options, err := c.options()
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 2
	}
	if c.jsonOutput || command == commandInvoke || command == commandSession {
		// Machine output owns stdout; progress goes to stderr.
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
	case commandInvoke:
		return c.invoke(ctx, runner)
	case commandSession:
		return c.session(ctx, runner)
	case "down":
		return c.down(ctx, runner)
	default:
		return c.serve(ctx, runner)
	}
}

func (c *commandConfig) session(ctx context.Context, runner *localrunner.Runner) int {
	fmt.Fprintf(os.Stderr, "apptheory-local: session %s\n", c.app)
	if err := runner.RunSession(ctx, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	return 0
}

func (c *commandConfig) invoke(ctx context.Context, runner *localrunner.Runner) int {
	reader, closeReader, err := c.invokeReader()
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	defer closeReader()
	if err := runner.RunInvoke(ctx, c.function, reader, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	return 0
}

func (c *commandConfig) invokeReader() (io.Reader, func(), error) {
	if c.stdio {
		return os.Stdin, func() {}, nil
	}
	var readers []io.Reader
	var files []*os.File
	for _, path := range c.events {
		file, err := os.Open(path) //nolint:gosec // the caller names the event file
		if err != nil {
			for _, opened := range files {
				_ = opened.Close() //nolint:errcheck // best-effort cleanup on the error path
			}
			return nil, func() {}, fmt.Errorf("open event file %s: %w", path, err)
		}
		files = append(files, file)
		readers = append(readers, file, bytes.NewReader([]byte("\n")))
	}
	return io.MultiReader(readers...), func() {
		for _, file := range files {
			_ = file.Close() //nolint:errcheck // input files are only read
		}
	}, nil
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
	surfaces, err := runner.PublicSurfacePlans(spec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apptheory-local: %v\n", err)
		return 1
	}
	fmt.Printf("app:      %s\n", c.app)
	fmt.Printf("assembly: %s\n", spec.AssemblyDir)
	fmt.Printf("runtime:  %s\n", runtimeModeLabel(runner.RuntimeMode()))
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
	fmt.Println()
	fmt.Println("public surfaces:")
	for _, surface := range surfaces {
		port := "auto"
		if surface.Port > 0 {
			port = fmt.Sprintf("%d", surface.Port)
		}
		note := ""
		if surface.Pinned {
			note = " (pinned)"
		}
		fmt.Printf("  %-12s %-44s %5s%s\n", surface.Class, surface.LogicalID, port, note)
	}
	printProvisionedResources(spec)
	printCodeBuildProjects(spec)
	printCustomResources(spec)
	printReceiptRules(spec)
	printIAMRoles(spec)
	printDerivedEvents(spec)
	if len(spec.Skipped) > 0 {
		fmt.Println()
		fmt.Println("not served locally:")
		for _, skipped := range spec.Skipped {
			fmt.Printf("  %-40s %s\n", skipped.LogicalID, skipped.Reason)
		}
	}
	return 0
}

// runtimeModeLabel renders the function transport the run uses.
func runtimeModeLabel(mode string) string {
	if mode == "rie" {
		return "rie (the image's Runtime Interface Emulator; responses are buffered)"
	}
	return "runner (the runner's Lambda Runtime API)"
}

// printProvisionedResources prints every resource the run creates from the CDK
// definition, with the local identifier the definition fixes before a backend
// starts. A generated identifier is marked because the provider assigns it.
func printProvisionedResources(spec *localrunner.Spec) {
	if len(spec.PlannedResources) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("provisioned resources:")
	for _, resource := range spec.PlannedResources {
		localID := resource.LocalID
		if resource.Generated {
			localID += " (assigned at run)"
		}
		fmt.Printf("  %-40s %-40s %s\n", resource.LogicalID, resource.Type, localID)
	}
}

// printCodeBuildProjects prints the projects the local CodeBuild endpoint
// serves, with the profile's local image mapping and every named deviation.
func printCodeBuildProjects(spec *localrunner.Spec) {
	if len(spec.CodeBuildProjects) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("codebuild projects:")
	for _, project := range spec.CodeBuildProjects {
		fmt.Printf("  %-40s %-40s image=%s timeout=%dm\n",
			project.LogicalID, project.Name, project.Image, project.TimeoutMinutes)
		for _, deviation := range project.Deviations {
			fmt.Printf("    deviation: %s\n", deviation)
		}
	}
}

// printCustomResources prints every CloudFormation custom resource the run
// serves, with the handler it invokes, the runner component that serves it, or
// the reason it refuses it.
func printCustomResources(spec *localrunner.Spec) {
	if len(spec.CustomResources) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("custom resources:")
	for _, resource := range spec.CustomResources {
		switch {
		case resource.Refusal != "":
			fmt.Printf("  %-40s %-42s refused: %s\n", resource.LogicalID, resource.Type, resource.Refusal)
		case resource.ServedBy != "":
			fmt.Printf("  %-40s %-42s served by the runner: %s\n", resource.LogicalID, resource.Type, resource.ServedBy)
		default:
			fmt.Printf("  %-40s %-42s handler=%s\n", resource.LogicalID, resource.Type, resource.Function)
		}
	}
}

// printReceiptRules prints every SES receipt rule the run serves, with the
// recipients it accepts and the actions it applies in order.
func printReceiptRules(spec *localrunner.Spec) {
	if len(spec.ReceiptRules) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("receipt rules:")
	for _, rule := range spec.ReceiptRules {
		actions := make([]string, 0, len(rule.Actions))
		for _, action := range rule.Actions {
			switch action.Kind {
			case "s3":
				actions = append(actions, "s3:"+action.Bucket+" prefix="+action.ObjectKeyPrefix)
			case "lambda":
				actions = append(actions, "lambda:"+action.Function+" invocation="+action.InvocationType)
			default:
				actions = append(actions, action.Kind)
			}
		}
		line := strings.Join(actions, ", ")
		if len(rule.UnservedActions) > 0 {
			line += " (not served: " + strings.Join(rule.UnservedActions, ", ") + ")"
		}
		fmt.Printf("  %-40s rule-set=%s name=%s enabled=%t recipients=%s -> %s\n",
			rule.LogicalID, rule.RuleSetName, rule.Name, rule.Enabled,
			strings.Join(rule.Recipients, ","), line)
	}
}

// printIAMRoles prints every IAM role the assembly declares with the trust and
// identity policies the narrow local IAM path evaluates.
func printIAMRoles(spec *localrunner.Spec) {
	if len(spec.IAMRoles) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("iam roles:")
	for _, role := range spec.IAMRoles {
		fmt.Printf("  %-52s trust=%t identityPolicies=%d account=%s\n",
			role.ARN, len(role.Trust) > 0, len(role.Identity), role.Account)
	}
	for _, api := range spec.APIs {
		if len(api.ResourcePolicy) == 0 {
			continue
		}
		fmt.Printf("  resource policy: %s\n", api.LogicalID)
	}
}

// printDerivedEvents prints every derived mapping, rule and subscription with
// the delivery state the engine would register.
func printDerivedEvents(spec *localrunner.Spec) {
	delivery := map[string]localrunner.DeliveryState{}
	for _, state := range spec.Delivery {
		delivery[state.ID] = state
	}
	if len(spec.EventSources) > 0 {
		fmt.Println()
		fmt.Println("event sources:")
		for _, source := range spec.EventSources {
			fmt.Printf("  %-40s %-9s <- %-28s -> %s batch=%d reportBatchItemFailures=%t enabled=%t delivery=%s\n",
				source.LogicalID, source.Type, source.SourceName, source.Function, source.BatchSize,
				source.ReportBatchItemFailures, source.Enabled, localrunner.DeliveryCell(delivery[source.LogicalID]))
		}
	}
	if len(spec.Rules) > 0 {
		fmt.Println()
		fmt.Println("eventbridge rules:")
		for _, rule := range spec.Rules {
			description := "schedule=" + rule.Schedule
			if len(rule.EventPattern) > 0 {
				description = "pattern=" + string(rule.EventPattern)
			}
			fmt.Printf("  %-40s %s -> %s delivery=%s\n",
				rule.LogicalID, description, strings.Join(rule.Targets, ", "),
				localrunner.DeliveryCell(delivery[rule.LogicalID]))
		}
	}
	if len(spec.Notifications) > 0 {
		fmt.Println()
		fmt.Println("s3 notifications:")
		for _, notification := range spec.Notifications {
			events := strings.Join(notification.Events, ",")
			filters := "none"
			if len(notification.FilterRules) > 0 {
				parts := make([]string, 0, len(notification.FilterRules))
				for _, rule := range notification.FilterRules {
					parts = append(parts, rule.Name+"="+rule.Value)
				}
				filters = strings.Join(parts, ",")
			}
			fmt.Printf("  %-40s %-12s <- %s[%s] events=%s filter=%s -> %s delivery=%s\n",
				notification.LogicalID, notification.DestinationType, notification.BucketName,
				notification.Bucket, events, filters, notification.Destination,
				localrunner.DeliveryCell(delivery[notification.LogicalID]))
		}
	}
	if len(spec.Subscriptions) > 0 {
		fmt.Println()
		fmt.Println("subscriptions:")
		for _, subscription := range spec.Subscriptions {
			if subscription.Kind == "sns" {
				filter := subscription.FilterPolicyScope
				if len(subscription.FilterPolicy) == 0 {
					filter = "none"
				}
				fmt.Printf("  %-40s %-16s <- %s -> %s %s filter=%s raw=%t delivery=%s\n",
					subscription.LogicalID, subscription.Kind, subscription.Topic,
					subscription.Protocol, subscription.Endpoint, filter,
					subscription.RawMessageDelivery,
					localrunner.DeliveryCell(delivery[subscription.LogicalID]))
				continue
			}
			fmt.Printf("  %-40s %-16s <- %s filter=%s -> %s delivery=%s\n",
				subscription.LogicalID, subscription.Kind, subscription.LogGroup,
				subscription.FilterName, subscription.Destination,
				localrunner.DeliveryCell(delivery[subscription.LogicalID]))
		}
	}
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
	origins, originsErr := splitPairList(c.origins, "origin")
	if originsErr != nil {
		return localrunner.Options{}, originsErr
	}
	ports, portsErr := localrunner.ParsePortPins(c.ports, c.portBase)
	if portsErr != nil {
		return localrunner.Options{}, portsErr
	}
	var handler *localrunner.HandlerSpec
	if strings.TrimSpace(c.handlerDir) != "" {
		handler = &localrunner.HandlerSpec{
			CodeDir:      c.handlerDir,
			Runtime:      c.runtime,
			Handler:      c.handler,
			Architecture: c.architecture,
			MemoryMB:     c.memoryMB,
			Timeout:      c.timeoutSeconds,
		}
	}
	return localrunner.Options{
		AppDir:              c.app,
		Handler:             handler,
		Context:             contexts,
		AssemblyDir:         c.assemblyDir,
		ScratchDir:          c.scratchDir,
		ProfilePath:         c.profilePath,
		Images:              images,
		Endpoints:           endpoints,
		Origins:             origins,
		ViewerCountry:       c.viewerCountry,
		AddHosts:            c.addHosts,
		Backends:            c.backends,
		ExtraFunctions:      append([]string(nil), c.sessionTargets...),
		PortBase:            c.portBase,
		Ports:               ports,
		NamePrefix:          c.namePrefix,
		MaxConcurrency:      c.maxConcurrency,
		DeliveryConcurrency: c.deliveryConcurrency,
		Clock:               c.clock,
		AllowNoSurface:      c.allowNoSurface,
		RIEMode:             c.rieMode,
		StreamChunks:        c.streamChunks,
		Watch:               c.watch,
		DataDir:             c.dataDir,
		SharedDir:           c.sharedDir,
		Seed:                c.seed,
		TLS:                 c.tls,
		TLSHost:             c.tlsHost,
		TLSAuxHosts:         append([]string(nil), c.tlsAux...),
		Stdout:              os.Stdout,
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

const tlsUsageText = `apptheory-local tls manages the local certificate authority an opted-in run uses.

Usage:
  apptheory-local tls ca   --data-dir <dir>
  apptheory-local tls leaf --data-dir <dir> --name <host> [--name <host>...] --out <dir>

` + "ca" + ` creates the CA on first use and prints its certificate and key paths.
` + "leaf" + ` issues a server certificate for an auxiliary service (for example a local
OIDC test IdP) from the same CA. Both commands print paths only, never key
material. The CA lives under <data-dir>/tls with the key at 0600 and the
directory at 0700.
`

// runTLSCommand implements `apptheory-local tls ca|leaf`.
func runTLSCommand(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, tlsUsageText)
		return 2
	}
	subcommand := args[0]
	flags := flag.NewFlagSet("apptheory-local tls "+subcommand, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	dataDir := flags.String("data-dir", "", "directory that keeps the CA across runs")
	switch subcommand {
	case "ca":
		if err := flags.Parse(args[1:]); err != nil {
			return 2
		}
		certPath, keyPath, err := localrunner.TLSCA(*dataDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "apptheory-local tls ca: %v\n", err)
			return 1
		}
		fmt.Printf("ca:  %s\nkey: %s\n", certPath, keyPath)
		return 0
	case "leaf":
		var names stringList
		flags.Var(&names, "name", "a localhost or *.localhost name the certificate must cover (repeatable)")
		out := flags.String("out", "", "directory for cert.pem and key.pem")
		if err := flags.Parse(args[1:]); err != nil {
			return 2
		}
		certPath, keyPath, err := localrunner.TLSLeaf(*dataDir, names, *out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "apptheory-local tls leaf: %v\n", err)
			return 1
		}
		fmt.Printf("cert: %s\nkey:  %s\n", certPath, keyPath)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "apptheory-local tls: unknown subcommand %q\n\n%s", subcommand, tlsUsageText)
		return 2
	}
}
