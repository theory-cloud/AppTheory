package localrunner

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Port pinning for public surfaces.
//
// A run binds its public listeners from one counter, `--port-base + index`, in
// a fixed order: HTTP and REST APIs, Function URLs, WebSocket APIs, then
// CloudFront distributions. That order is an implementation detail, so a
// co-resident app whose clients register exact URLs cannot rely on it. A pin
// names one served surface and declares the port it must use:
//
//	--port PublicApiDistribution2C9B2239=8270
//
// Pinned ports are reserved first and the counter skips them, so every unpinned
// surface keeps exactly the port it had before pinning existed for the same
// base and surface set. A run with no pins and no base keeps the ephemeral
// behavior: the OS assigns every port.
//
// A pin that names no served surface, repeats a surface, collides with another
// pin, or falls outside the run's range fails closed with a named error before
// any container starts.

// PortPin is one declared public-surface port.
type PortPin struct {
	// LogicalID is the served surface's CDK logical id (an API, a Function
	// URL, a WebSocket API or a CloudFront distribution).
	LogicalID string
	// Port is the TCP port the surface must bind.
	Port int
}

// PublicSurfacePlan is one public listener's allocation. Port is 0 when the
// run has no base and the OS assigns it at start; Automatic reports that case.
type PublicSurfacePlan struct {
	Class     APIClass `json:"class"`
	LogicalID string   `json:"logicalId"`
	Port      int      `json:"port"`
	Pinned    bool     `json:"pinned,omitempty"`
	Automatic bool     `json:"automatic,omitempty"`
}

// parsedPortPin is a validated pin, kept in declaration order so errors name
// the same surface every time.
type parsedPortPin struct {
	logicalID string
	port      int
}

// PublicSurfacePlans resolves this runner's port allocation for a spec. Plan,
// describe and the run all use it, so they cannot disagree about a port.
func (r *Runner) PublicSurfacePlans(spec *Spec) ([]PublicSurfacePlan, error) {
	return PlanPublicSurfaces(spec, r.options.PortBase, r.options.Ports)
}

// PlanPublicSurfaces applies the pins to the surfaces a run serves and returns
// the allocation in the order the listeners start.
func PlanPublicSurfaces(spec *Spec, portBase int, pins []PortPin) ([]PublicSurfacePlan, error) {
	if spec == nil {
		return nil, errors.New("the run has no derived surface to plan ports for")
	}
	surfaces := servedPublicSurfaces(spec)
	parsed, err := validatePortPins(spec, surfaces, portBase, pins)
	if err != nil {
		return nil, err
	}
	return allocatePublicPorts(surfaces, portBase, parsed), nil
}

// validatePortPins checks every declared pin against the served surface set and
// the run's range. It returns the pins in declaration order so a named error is
// deterministic.
func validatePortPins(spec *Spec, surfaces []PublicSurfacePlan, portBase int, pins []PortPin) ([]parsedPortPin, error) {
	if len(pins) > 0 && portBase <= 0 {
		return nil, errors.New("--port needs --port-base: a pinned port is reserved inside the run's range, and without --port-base the run has no declared range")
	}
	if portBase > 0 && portBase+len(surfaces) > 65536 {
		return nil, fmt.Errorf("--port-base %d with %d public surface(s) runs past TCP port 65535", portBase, len(surfaces))
	}
	served := make(map[string]PublicSurfacePlan, len(surfaces))
	for _, surface := range surfaces {
		served[surface.LogicalID] = surface
	}
	parsed := make([]parsedPortPin, 0, len(pins))
	for _, pin := range pins {
		entry, err := validatePortPin(spec, served, len(surfaces), portBase, parsed, pin)
		if err != nil {
			return nil, err
		}
		parsed = append(parsed, entry)
	}
	return parsed, nil
}

// validatePortPin checks one declaration against the served set, the run's
// range and the pins already accepted.
func validatePortPin(spec *Spec, served map[string]PublicSurfacePlan, surfaceCount, portBase int, previous []parsedPortPin, pin PortPin) (parsedPortPin, error) {
	logicalID := strings.TrimSpace(pin.LogicalID)
	if logicalID == "" {
		return parsedPortPin{}, errors.New("--port needs a logical id: use --port <logicalId>=<port>")
	}
	if pin.Port < 1 || pin.Port > 65535 {
		return parsedPortPin{}, fmt.Errorf("--port %s=%d: %d is not a TCP port", logicalID, pin.Port, pin.Port)
	}
	if _, ok := served[logicalID]; !ok {
		return parsedPortPin{}, fmt.Errorf("--port %s=%d: %s", logicalID, pin.Port, unservedSurfaceReason(spec, logicalID))
	}
	if err := portPinConflict(previous, logicalID, pin.Port); err != nil {
		return parsedPortPin{}, err
	}
	if portBase > 0 && (pin.Port < portBase || pin.Port >= portBase+surfaceCount) {
		return parsedPortPin{}, fmt.Errorf(
			"--port %s=%d is outside the run's range %d-%d: --port-base %d with %d public surface(s) reserves one slot per surface",
			logicalID, pin.Port, portBase, portBase+surfaceCount-1, portBase, surfaceCount)
	}
	return parsedPortPin{logicalID: logicalID, port: pin.Port}, nil
}

// portPinConflict refuses a repeated surface or a shared port.
func portPinConflict(previous []parsedPortPin, logicalID string, port int) error {
	for _, prior := range previous {
		if prior.logicalID == logicalID {
			return fmt.Errorf("--port %s=%d: the surface is pinned twice (already --port %s=%d)", logicalID, port, prior.logicalID, prior.port)
		}
		if prior.port == port {
			return fmt.Errorf("--port %s=%d collides with --port %s=%d: two surfaces cannot share one port", logicalID, port, prior.logicalID, prior.port)
		}
	}
	return nil
}

// allocatePublicPorts reserves the pinned ports first, then walks the surfaces
// in listener order and gives each unpinned surface the next free slot of the
// run's range. With no base each unpinned surface stays ephemeral.
func allocatePublicPorts(surfaces []PublicSurfacePlan, portBase int, parsed []parsedPortPin) []PublicSurfacePlan {
	pinned := make(map[string]int, len(parsed))
	reserved := make(map[int]bool, len(parsed))
	for _, pin := range parsed {
		pinned[pin.logicalID] = pin.port
		reserved[pin.port] = true
	}
	plans := make([]PublicSurfacePlan, 0, len(surfaces))
	next := portBase
	for _, surface := range surfaces {
		if port, ok := pinned[surface.LogicalID]; ok {
			surface.Port = port
			surface.Pinned = true
			plans = append(plans, surface)
			continue
		}
		if portBase <= 0 {
			surface.Automatic = true
			plans = append(plans, surface)
			continue
		}
		for reserved[next] {
			next++
		}
		surface.Port = next
		next++
		plans = append(plans, surface)
	}
	return plans
}

// surfacePinned reports whether the allocation pinned one surface.
func (r *Runner) surfacePinned(logicalID string) bool {
	for _, plan := range r.surfacePlans {
		if plan.LogicalID == logicalID {
			return plan.Pinned
		}
	}
	return false
}

// servedPublicSurfaces lists the public listeners a run starts, in the order
// startServers starts them.
func servedPublicSurfaces(spec *Spec) []PublicSurfacePlan {
	surfaces := make([]PublicSurfacePlan, 0, len(spec.APIs)+len(spec.FunctionURLs)+len(spec.WebSockets)+len(spec.CloudFront))
	for _, api := range spec.HTTPAPIs() {
		surfaces = append(surfaces, PublicSurfacePlan{Class: api.Class, LogicalID: api.LogicalID})
	}
	for _, url := range spec.FunctionURLs {
		surfaces = append(surfaces, PublicSurfacePlan{Class: APIFunctionURL, LogicalID: url.LogicalID})
	}
	for _, api := range spec.WebSockets {
		surfaces = append(surfaces, PublicSurfacePlan{Class: api.Class, LogicalID: api.LogicalID})
	}
	for _, distribution := range spec.ServableCloudFront() {
		surfaces = append(surfaces, PublicSurfacePlan{Class: apiCloudFront, LogicalID: distribution.LogicalID})
	}
	return surfaces
}

// unservedSurfaceReason explains why a logical id cannot be pinned. It
// distinguishes a typo from a construct the assembly declares but the runner
// does not serve, because those are different fixes.
func unservedSurfaceReason(spec *Spec, logicalID string) string {
	for _, api := range spec.APIs {
		if api.LogicalID == logicalID {
			return "the assembly declares that API, but it serves no route locally, so it has no listener to pin"
		}
	}
	for _, distribution := range spec.CloudFront {
		if distribution.LogicalID == logicalID {
			return "the assembly declares that CloudFront distribution, but it is not servable locally (see the plan's not served list), so it has no listener to pin"
		}
	}
	for _, function := range spec.Functions {
		if function.LogicalID == logicalID {
			return "that is a function, not a public listener; pin the API, Function URL, WebSocket or distribution it serves"
		}
	}
	return "the assembly serves no public surface with that logical id (a pin names an API, Function URL, WebSocket API or CloudFront distribution)"
}

// apiCloudFront labels a CloudFront distribution in a surface plan.
const apiCloudFront APIClass = "cloudfront"

// ParsePortPins parses repeated --port <logicalId>=<port> values.
func ParsePortPins(values []string, portBase int) ([]PortPin, error) {
	pins := make([]PortPin, 0, len(values))
	for _, value := range values {
		logicalID, rawPort, ok := strings.Cut(strings.TrimSpace(value), "=")
		logicalID = strings.TrimSpace(logicalID)
		if !ok || logicalID == "" {
			return nil, fmt.Errorf("--port %q must be <logicalId>=<port>", value)
		}
		port, err := strconv.Atoi(strings.TrimSpace(rawPort))
		if err != nil {
			return nil, fmt.Errorf("--port %q: %q is not a port number", value, rawPort)
		}
		pins = append(pins, PortPin{LogicalID: logicalID, Port: port})
	}
	if len(pins) > 0 && portBase <= 0 {
		return nil, errors.New("--port needs --port-base: a pinned port is reserved inside the run's range")
	}
	return pins, nil
}
