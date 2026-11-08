package localrunner

import (
	"context"
	"fmt"
	"strings"
)

// Local backends.
//
// A --backend starts the profile's digest-pinned emulator on the run (or shared)
// network, injects its endpoint and waits for a read-only protocol call before
// the run provisions against it.

// backendProcess is a local emulator container the run owns.
type backendProcess struct {
	Container string
	// Alias is the network name the profile's endpoints use, for example
	// "dynamodb-local" or "moto".
	Alias     string
	Endpoints []Endpoint
	// HostURL is the loopback base URL for the runner's own provisioning
	// calls. It is never injected into a function container.
	HostURL string
}

// startBackends starts every local emulator configured from the profile.
func (r *Runner) startBackends(ctx context.Context) error {
	for _, backend := range r.options.Backends {
		if err := r.startBackend(ctx, backend); err != nil {
			return err
		}
	}
	return nil
}

// startBackend starts one emulator, resolves its network address for the
// function containers' closed DNS and waits until its published host port
// answers a read-only protocol call.
//
//nolint:gocyclo // one branch per backend shape.
func (r *Runner) startBackend(ctx context.Context, backend string) error {
	container := backendContainer(backend)
	pin, err := r.profile.Container(container)
	if err != nil {
		return fmt.Errorf("backend %s: %w", backend, err)
	}
	name := r.backendsContainerName(backend)
	// On a shared network two runs would otherwise publish the same "moto" (or
	// "s3proxy") alias, and Docker's DNS would answer with either run's
	// container. A run-scoped alias keeps every endpoint inside its own run.
	alias := r.sharedAlias(container)
	pin, dataMounts, err := r.configureBackendDataDir(backend, container, pin)
	if err != nil {
		return err
	}
	endpoints := r.profile.EndpointsForContainer(container)
	if alias != container {
		for index := range endpoints {
			endpoints[index].URL = replaceURLHost(endpoints[index].URL, alias)
		}
	}
	if backend == backendDynamoDB && !containsEndpointService(endpoints, backendDynamoDB) {
		endpoints = append(endpoints, Endpoint{Service: backendDynamoDB, URL: "http://" + alias + ":8000"})
	}
	// Register the container before starting it, so a signal that lands
	// while the start or the address lookup is in flight still cleans it up.
	r.backends[backend] = backendProcess{
		Container: name,
		Alias:     alias,
		Endpoints: endpoints,
	}
	options := ContainerOptions{
		Name:    name,
		Network: r.network,
		Aliases: []string{alias},
		Image:   pin.Image,
		Command: pin.Command,
		Env:     pin.Environment,
		Mounts:  append(append([]string(nil), pin.Mounts...), dataMounts...),
		Publish: pin.ContainerPort,
		Labels:  r.labels(),
		Detach:  true,
	}
	if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
		return startErr
	}
	address, err := r.docker.ContainerIP(ctx, name, r.network)
	if err != nil {
		return err
	}
	r.options.AddHosts = append(r.options.AddHosts, alias+":"+address)
	// An S3 SDK picks virtual-hosted addressing for a named endpoint
	// ("bucket.s3proxy") and path addressing for an IP endpoint. s3proxy
	// only serves the latter, so the S3 endpoint uses the container address.
	if container == "s3proxy" {
		for index := range r.endpoints {
			if r.endpoints[index].Service == "s3" {
				r.endpoints[index].URL = fmt.Sprintf("http://%s:%d", address, pin.ContainerPort)
			}
		}
	}
	process := r.backends[backend]
	if pin.ContainerPort > 0 {
		hostPort, portErr := r.docker.PublishedPort(ctx, name, pin.ContainerPort)
		if portErr != nil {
			return portErr
		}
		if hostPort == 0 {
			return fmt.Errorf("backend %s published no loopback port for container port %d", backend, pin.ContainerPort)
		}
		process.HostURL = fmt.Sprintf("http://127.0.0.1:%d", hostPort)
	}
	r.backends[backend] = process
	// A backend with a published host port must answer a real request before
	// the runner provisions against it or reports it ready. The container may
	// already accept TCP connections while its HTTP server still resets the
	// first request.
	if process.HostURL != "" {
		if err := r.waitForBackendReady(ctx, backend, pin.Image, process); err != nil {
			return err
		}
	}
	var urls []string
	for _, endpoint := range endpoints {
		urls = append(urls, endpoint.URL)
	}
	r.logf("backend %s (%s) ready at %s", backend, pin.Image, strings.Join(urls, ", "))
	return nil
}

func (r *Runner) backendsContainerName(backend string) string {
	if backend == backendDynamoDB {
		return r.namePrefix + "-" + backendDynamoDB
	}
	return r.namePrefix + "-" + sanitizeName(backend)
}
