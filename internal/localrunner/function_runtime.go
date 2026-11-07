package localrunner

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Function execution environment construction and reset.

// functionRunOptions builds the container configuration for one function. A
// watch reload reuses it, so a restarted function receives exactly the options
// a fresh start would have produced.
//
//nolint:gocognit,gocyclo // one branch per function shape the assembly can declare
func (r *Runner) functionRunOptions(ctx context.Context, function FunctionSpec, image string) (*runtimeAPI, ContainerOptions, error) {
	imageFunction := function.ImageAsset != nil
	codeDir := function.AssetDir
	if codeDir == "" && !imageFunction {
		return nil, ContainerOptions{}, fmt.Errorf("function %s has no code directory", function.LogicalID)
	}
	if codeDir != "" {
		if err := ensureSharedPath(codeDir); err != nil {
			return nil, ContainerOptions{}, fmt.Errorf("function %s: %w", function.LogicalID, err)
		}
	}
	command, err := functionCommand(function)
	if err != nil {
		return nil, ContainerOptions{}, err
	}
	var api *runtimeAPI
	if !r.options.RIEMode {
		api, err = newRuntimeAPI(function, r.logf)
		if err != nil {
			return nil, ContainerOptions{}, err
		}
		api.gateway = r.networkGateway
		if r.runtimeAPIGateway != "" {
			api.bindGateway(r.runtimeAPIGateway)
		}
	}
	env, overridden := r.functionEnvironment(function, api)
	if r.options.RIEMode {
		// The emulator reads its timeout from AWS_LAMBDA_FUNCTION_TIMEOUT; the
		// base image's entry script does not set it.
		// https://github.com/aws/aws-lambda-runtime-interface-emulator
		env["AWS_LAMBDA_FUNCTION_TIMEOUT"] = strconv.Itoa(function.Timeout)
	}
	if len(overridden) > 0 {
		r.logf("function %s: runner-owned environment overrides template values for %s", function.LogicalID, strings.Join(overridden, ", "))
	}
	if len(function.Layers) > 0 {
		layerEnv, layerErr := r.layerEnvironment(ctx, function, image, env)
		if layerErr != nil {
			return nil, ContainerOptions{}, layerErr
		}
		env = layerEnv
	}
	if len(function.EnvironmentExpressions) > 0 {
		return nil, ContainerOptions{}, unsupported(
			function.LogicalID,
			"environment expressions were not resolved before the container start: %s",
			strings.Join(sortedKeys(function.EnvironmentExpressions), ", "),
		)
	}
	if limitErr := unresolvedLimitsError(function); limitErr != nil {
		return nil, ContainerOptions{}, limitErr
	}
	if api != nil {
		// The container reaches the Runtime API through host.docker.internal.
		// The run's closed DNS server cannot resolve it, so the host entry is
		// required (the run network also sets --dns 127.0.0.2).
		r.addRuntimeHostEntry()
	}
	mounts := append(functionMounts(function), r.webSocketCertificateMounts()...)
	mounts = append(mounts, r.tlsTrustMounts()...)
	publish := 0
	if r.options.RIEMode {
		publish = riePort
	}
	options := ContainerOptions{
		Name:     r.containerName(function.LogicalID),
		Network:  r.network,
		Image:    image,
		Command:  command,
		Env:      env,
		AddHosts: r.options.AddHosts,
		MemoryMB: function.MemoryMB,
		Mounts:   mounts,
		Publish:  publish,
		Labels:   r.labels(),
		Detach:   true,
	}
	return api, options, nil
}

//nolint:gocognit,gocyclo // one branch per function shape the assembly can declare
func (r *Runner) startFunction(ctx context.Context, function FunctionSpec, image string) error {
	api, options, err := r.functionRunOptions(ctx, function, image)
	if err != nil {
		return err
	}
	name := options.Name
	// Register the container before starting it, so a signal that lands while
	// the runtime image is still starting or waiting to accept connections
	// still removes it.
	process := &FunctionProcess{
		Function:  function,
		Container: name,
		Image:     image,
		Started:   time.Now().UTC(),
		rie:       r.options.RIEMode,
		api:       api,
		options:   options,
		logf:      r.logf,
	}
	if api != nil {
		api.running = func(checkCtx context.Context) (bool, error) {
			return r.docker.Running(checkCtx, name)
		}
		process.reset = r.resetFunction
	}
	r.invokers[function.LogicalID] = process
	if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
		process.closeRuntimeAPI()
		return startErr
	}
	if err := process.awaitReady(ctx, r.docker); err != nil {
		if function.ImageAsset != nil && r.options.RIEMode {
			return fmt.Errorf(
				"function %s: the container image did not start a Runtime Interface Emulator on port %d; an image function must be based on an AWS base image that ships one (https://docs.aws.amazon.com/lambda/latest/dg/images-create.html): %w",
				function.LogicalID, riePort, err,
			)
		}
		return err
	}
	r.rememberRuntimeAPIAddress(process)
	if r.options.RIEMode {
		r.logf("function %s (%s, %s) ready on 127.0.0.1:%d (Runtime Interface Emulator mode)", function.LogicalID, function.Runtime, image, process.Port)
		return nil
	}
	if failure := process.api.initError(); failure != nil {
		if failure.Type == "Runtime.ExitError" {
			// A runtime client that fails its first Next API request exits
			// before the Init phase completes. The lifecycle page resets and
			// re-initializes the environment, so the runner retries once before
			// reporting the failure to the first invocation.
			// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
			r.logf("function %s (%s, %s): the runtime exited before its first invocation (%s); restarting it once",
				function.LogicalID, function.Runtime, image, failure.Message)
			if resetErr := r.resetFunction(ctx, process); resetErr != nil {
				return fmt.Errorf("function %s: restart after a failed initialization: %w", function.LogicalID, resetErr)
			}
			failure = process.api.initError()
		}
		if failure != nil {
			r.logf("function %s (%s, %s): initialization failed; the first invocation reports %s", function.LogicalID, function.Runtime, image, failure.Type)
		}
		return nil
	}
	r.logf("function %s (%s, %s) ready on the runner's Runtime API at %s", function.LogicalID, function.Runtime, image, process.RuntimeAPIURL())
	return nil
}

// awaitReady waits for the process's runtime to signal that the Init phase
// finished: the embedded emulator's port in RIE mode, or the runtime's first
// Next API request in the default mode.
func (p *FunctionProcess) awaitReady(ctx context.Context, docker *Docker) error {
	if p.rie {
		port, err := waitForContainerReady(ctx, docker, p.Container)
		if err != nil {
			return err
		}
		p.Port = port
		return nil
	}
	return waitForRuntimeAPIReady(ctx, docker, p.Container, p.api)
}

// resetFunction replaces one function's execution environment after a timeout,
// a crash or an initialization failure. The container keeps its name and the
// FunctionProcess keeps its identity, so every caller's handle stays valid.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
func (r *Runner) resetFunction(ctx context.Context, process *FunctionProcess) error {
	r.logf("function %s: replacing the execution environment", process.Function.LogicalID)
	r.docker.RemoveContainer(ctx, process.Container)
	gateway := ""
	if process.api != nil {
		gateway = process.api.gatewayBound()
	}
	process.closeRuntimeAPI()
	options := process.options
	if !process.rie {
		api, err := newRuntimeAPI(process.Function, r.logf)
		if err != nil {
			return err
		}
		api.gateway = r.networkGateway
		if gateway == "" {
			gateway = r.runtimeAPIGateway
		}
		if gateway != "" && api.bindGateway(gateway) {
			r.runtimeAPIGateway = gateway
		}
		api.running = func(checkCtx context.Context) (bool, error) {
			return r.docker.Running(checkCtx, process.Container)
		}
		process.api = api
		options.Env = cloneEnvironment(options.Env)
		options.Env["AWS_LAMBDA_RUNTIME_API"] = api.ContainerAddress()
	}
	process.options = options
	if _, err := r.docker.StartContainer(ctx, options); err != nil {
		return err
	}
	process.Started = time.Now().UTC()
	if err := process.awaitReady(ctx, r.docker); err != nil {
		return err
	}
	r.rememberRuntimeAPIAddress(process)
	return nil
}
