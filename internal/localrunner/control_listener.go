package localrunner

import (
	"context"
	"fmt"
	"net"
	"strconv"
)

// A local control endpoint (the EventBridge bus, the CloudFront invalidation
// API, the CodeBuild API and the WebSocket @connections API) is reached by
// function containers through host.docker.internal. It never binds the
// unspecified address: it binds loopback and, when the host owns the run
// network's gateway (the Linux bridge case), also that address on the same
// port. On Colima and Docker Desktop the gateway belongs to the VM, the bind
// fails harmlessly, and the container keeps Docker's host-gateway entry, which
// forwards to the host loopback.
type controlListeners struct {
	Loopback     net.Listener
	Gateway      net.Listener
	Port         int
	HostURL      string
	ContainerURL string
}

func (r *Runner) listenControl(ctx context.Context, service string) (*controlListeners, error) {
	var listenConfig net.ListenConfig
	loopback, err := listenConfig.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind the local %s control listener: %w", service, err)
	}
	tcpAddr, ok := loopback.Addr().(*net.TCPAddr)
	if !ok {
		_ = loopback.Close() //nolint:errcheck // the listener cannot be used without a TCP address
		return nil, fmt.Errorf("the local %s control listener has no TCP address", service)
	}
	port := tcpAddr.Port
	listeners := &controlListeners{
		Loopback:     loopback,
		Port:         port,
		HostURL:      fmt.Sprintf("http://127.0.0.1:%d", port),
		ContainerURL: fmt.Sprintf("http://host.docker.internal:%d", port),
	}
	if gateway := r.runtimeAPIGateway; gateway != "" {
		if listener, listenErr := listenConfig.Listen(ctx, "tcp", net.JoinHostPort(gateway, strconv.Itoa(port))); listenErr == nil {
			listeners.Gateway = listener
		} else {
			r.logf("%s control listener: the run network gateway %s is not host-owned (%v); loopback only", service, gateway, listenErr)
		}
	}
	r.listeners = append(r.listeners, loopback)
	if listeners.Gateway != nil {
		r.listeners = append(r.listeners, listeners.Gateway)
	}
	r.addRuntimeHostEntry()
	return listeners, nil
}
