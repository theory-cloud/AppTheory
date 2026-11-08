package localrunner

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
)

// Public listeners.
//
// A public listener serves the loopback URL a person or a row uses. It also
// binds the run network's gateway on the same port when the host owns it (the
// Linux bridge case), because a function container reaches the runner's URL
// through its host-gateway entry: the AWS_IAM callers sign a request to the
// served API, and the container must be able to deliver it. On Colima and
// Docker Desktop the gateway belongs to the VM and that bind fails harmlessly:
// the container's host-gateway entry forwards the name to the host loopback.

func (r *Runner) listenPublic(ctx context.Context, port int) ([]net.Listener, int, error) {
	loopback, err := r.listen(ctx, port)
	if err != nil {
		return nil, 0, err
	}
	address, ok := loopback.Addr().(*net.TCPAddr)
	if !ok {
		_ = loopback.Close() //nolint:errcheck // the listener cannot be used without a TCP address
		return nil, 0, errors.New("the public listener has no TCP address")
	}
	listeners := []net.Listener{loopback}
	if r.runtimeAPIGateway != "" {
		var listenConfig net.ListenConfig
		if gateway, listenErr := listenConfig.Listen(ctx, "tcp", net.JoinHostPort(r.runtimeAPIGateway, strconv.Itoa(address.Port))); listenErr == nil {
			listeners = append(listeners, gateway)
		} else {
			r.logf("public listener: the run network gateway %s is not host-owned (%v); loopback only", r.runtimeAPIGateway, listenErr)
		}
	}
	return listeners, address.Port, nil
}

// startPublicListener serves one public surface on every listener it bound and
// returns the port the run reports. A TLS run serves HTTPS with HTTP/1.1 and,
// when the client offers it, HTTP/2; a run without the opt-in serves the same
// plain HTTP listener as before.
func (r *Runner) startPublicListener(ctx context.Context, port int, server *http.Server, label string) (int, error) {
	listeners, port, err := r.listenPublic(ctx, port)
	if err != nil {
		return 0, err
	}
	if r.publicPorts == nil {
		r.publicPorts = map[int]bool{}
	}
	r.publicPorts[port] = true
	tlsConfig := r.serverTLSConfig()
	if tlsConfig != nil {
		server.TLSConfig = tlsConfig
	}
	r.servers = append(r.servers, server)
	for _, listener := range listeners {
		r.listeners = append(r.listeners, listener)
		go func(listener net.Listener) {
			var serveErr error
			if tlsConfig != nil {
				serveErr = server.ServeTLS(listener, "", "")
			} else {
				serveErr = server.Serve(listener)
			}
			if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("%s stopped: %v", label, serveErr)
			}
		}(listener)
	}
	return port, nil
}
