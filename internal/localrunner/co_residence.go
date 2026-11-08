package localrunner

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Co-resident runs and the host address their containers reach.
//
// A run binds its public listeners on loopback and, when the host owns the run
// network's gateway (native Linux), that address too; on Colima and Docker
// Desktop the gateway belongs to the VM, so the one add-host helper uses
// Docker's host-gateway value, which forwards to the host loopback. A
// --shared-network bridge gives every co-resident run the same host address
// without binding the unspecified address.

// sharedAlias is the network name a backend publishes. A private network keeps
// the profile's name; a shared network scopes it to this run, so two runs never
// answer one Docker DNS name.
func (r *Runner) sharedAlias(name string) string {
	if !r.sharedNetwork {
		return name
	}
	return sanitizeName(r.namePrefix + "-" + name)
}

// replaceURLHost rewrites a URL's host while keeping its scheme and port.
func replaceURLHost(raw, host string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return raw
	}
	if port := parsed.Port(); port != "" {
		parsed.Host = net.JoinHostPort(host, port)
	} else {
		parsed.Host = host
	}
	return parsed.String()
}

// ensureNetwork creates the run's private network, or joins the declared shared
// network. A shared network is created once by whichever run starts first and
// removed only by an explicit `down`, so a second run never deletes the bridge
// its sibling is using.
func (r *Runner) ensureNetwork(ctx context.Context) error {
	if !r.sharedNetwork {
		return r.docker.CreateNetwork(ctx, r.network, r.labels())
	}
	exists, err := r.docker.NetworkExists(ctx, r.network)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return r.docker.CreateNetwork(ctx, r.network, map[string]string{
		labelSharedNetwork: "true",
		labelManaged:       "true",
	})
}

// runtimeHostAddress is the address a container uses to reach the host: the
// run network's gateway when the host owns it (the Linux bridge case), or
// Docker's host-gateway value, which Colima and Docker Desktop forward to the
// host's loopback.
func (r *Runner) runtimeHostAddress() string {
	if r.runtimeAPIGateway != "" {
		return r.runtimeAPIGateway
	}
	return "host-gateway"
}

// addRuntimeHostEntry adds the host.docker.internal mapping once; an entry the
// caller supplied through --add-host wins.
func (r *Runner) addRuntimeHostEntry() {
	r.addHostEntry("host.docker.internal")
}

// addHostEntry maps one name to the container-facing host address once. It is
// the one helper every listener or host mapping the containers use goes
// through.
func (r *Runner) addHostEntry(name string) {
	name = strings.TrimSpace(name)
	if name == "" || hasAddHostName(r.options.AddHosts, name) {
		return
	}
	r.options.AddHosts = append(r.options.AddHosts, name+":"+r.runtimeHostAddress())
}

// runtimeAPIAddressOwner reports whether the host owns an address. Binding an
// ephemeral port and closing it at once is the proof; an address that belongs
// to the Docker VM (Colima, Docker Desktop) fails with EADDRNOTAVAIL.
var runtimeAPIAddressOwner = func(gateway string) bool {
	listener, err := net.Listen("tcp", net.JoinHostPort(gateway, "0"))
	if err != nil {
		return false
	}
	_ = listener.Close() //nolint:errcheck // the probe only proves ownership
	return true
}

// chooseRuntimeAPIAddress decides whether the container reaches the host
// through the run network's gateway. The host owns that address on Linux, so
// the container's host entry can name it and the listener can bind it; on
// Colima and Docker Desktop the address belongs to the VM, the bind fails, and
// the container keeps Docker's host-gateway entry (forwarded to the host's
// loopback). The probe binds an ephemeral port and closes it at once.
func (r *Runner) chooseRuntimeAPIAddress(ctx context.Context) {
	gateway, err := r.networkGateway(ctx)
	if err != nil {
		return
	}
	if !runtimeAPIAddressOwner(gateway) {
		return
	}
	r.runtimeAPIGateway = gateway
	r.logf("runtime API: the container host entry host.docker.internal -> %s (the run network's gateway)", gateway)
}

// rememberRuntimeAPIAddress keeps the gateway bind for later functions once a
// container could not reach loopback.
func (r *Runner) rememberRuntimeAPIAddress(process *FunctionProcess) {
	if process == nil || process.api == nil {
		return
	}
	if gateway := process.api.gatewayBound(); gateway != "" {
		r.runtimeAPIGateway = gateway
	}
}

// validateCoResidence checks the co-residence options before any synthesis.
func (r *Runner) validateCoResidence() error {
	network := strings.TrimSpace(r.options.SharedNetwork)
	if network != "" {
		if strings.ContainsAny(network, " \t/") {
			return fmt.Errorf("--shared-network %q is not a Docker network name", r.options.SharedNetwork)
		}
	}
	seen := map[string]bool{}
	for _, entry := range r.options.PeerHosts {
		name := strings.ToLower(strings.TrimSpace(entry))
		if name == "" {
			continue
		}
		if err := validateTLSHost(name); err != nil {
			return fmt.Errorf("--peer-host %q: %w", entry, err)
		}
		if seen[name] {
			return fmt.Errorf("--peer-host %q is declared twice", entry)
		}
		seen[name] = true
	}
	if len(seen) > 0 && !r.options.TLS {
		return errors.New("--peer-host needs --tls: a co-resident run's public name is only reachable over the verified HTTPS listener its shared CA signs")
	}
	return nil
}

func (r *Runner) listen(ctx context.Context, port int) (net.Listener, error) {
	var listenConfig net.ListenConfig
	if port > 0 {
		return listenConfig.Listen(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
	}
	return listenConfig.Listen(ctx, "tcp", "127.0.0.1:0")
}
