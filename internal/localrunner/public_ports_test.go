package localrunner

import (
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// portTestSpec builds a surface with the same ordering the runner starts:
// HTTP API, REST API, Function URL, WebSocket API, two distributions.
func portTestSpec(t *testing.T) *Spec {
	t.Helper()
	return &Spec{
		APIs: []APISpec{
			{Class: APIHTTPV2, LogicalID: "McpHttpApi", Routes: []Route{{Class: APIHTTPV2, Method: "GET", Path: "/health", Function: "Fn"}}},
			{Class: APIRESTV1, LogicalID: "VendingApi", Routes: []Route{{Class: APIRESTV1, Method: "POST", Path: "/v1", Function: "Fn"}}},
		},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "SsrUrl", Function: "Fn"}},
		WebSockets:   []WebSocketAPISpec{{LogicalID: "SocketApi"}},
		CloudFront: []*localcloudfront.Distribution{
			{LogicalID: "ControlPlaneDistribution"},
			{LogicalID: "PublicApiDistribution"},
		},
		Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "provided.al2023"}},
	}
}

func planPorts(t *testing.T, spec *Spec, base int, pins ...PortPin) []PublicSurfacePlan {
	t.Helper()
	plans, err := PlanPublicSurfaces(spec, base, pins)
	if err != nil {
		t.Fatalf("PlanPublicSurfaces: %v", err)
	}
	return plans
}

func planPortsError(t *testing.T, spec *Spec, base int, pins ...PortPin) string {
	t.Helper()
	_, err := PlanPublicSurfaces(spec, base, pins)
	if err == nil {
		t.Fatalf("PlanPublicSurfaces accepted %+v; want a named error", pins)
	}
	return err.Error()
}

func surfacePorts(plans []PublicSurfacePlan) map[string]int {
	out := map[string]int{}
	for _, plan := range plans {
		out[plan.LogicalID] = plan.Port
	}
	return out
}

func TestPlanPublicSurfacesKeepsTodaysAllocation(t *testing.T) {
	plans := planPorts(t, portTestSpec(t), 8270)
	want := []string{"McpHttpApi", "VendingApi", "SsrUrl", "SocketApi", "ControlPlaneDistribution", "PublicApiDistribution"}
	if len(plans) != len(want) {
		t.Fatalf("got %d surfaces, want %d", len(plans), len(want))
	}
	for index, plan := range plans {
		if plan.LogicalID != want[index] || plan.Port != 8270+index {
			t.Fatalf("surface %d = %s:%d, want %s:%d", index, plan.LogicalID, plan.Port, want[index], 8270+index)
		}
		if plan.Pinned || plan.Automatic {
			t.Fatalf("surface %s reports pinned=%v automatic=%v without a pin", plan.LogicalID, plan.Pinned, plan.Automatic)
		}
	}
}

func TestPlanPublicSurfacesPinsReserveFirstAndCounterSkips(t *testing.T) {
	spec := portTestSpec(t)
	plans := planPorts(t, spec, 8270,
		PortPin{LogicalID: "PublicApiDistribution", Port: 8270},
		PortPin{LogicalID: "ControlPlaneDistribution", Port: 8271},
	)
	ports := surfacePorts(plans)
	want := map[string]int{
		"McpHttpApi":               8272,
		"VendingApi":               8273,
		"SsrUrl":                   8274,
		"SocketApi":                8275,
		"ControlPlaneDistribution": 8271,
		"PublicApiDistribution":    8270,
	}
	for id, port := range want {
		if ports[id] != port {
			t.Fatalf("%s port = %d, want %d (allocation %v)", id, ports[id], port, ports)
		}
	}
	for _, plan := range plans {
		wantPinned := plan.LogicalID == "PublicApiDistribution" || plan.LogicalID == "ControlPlaneDistribution"
		if plan.Pinned != wantPinned {
			t.Fatalf("%s pinned = %v, want %v", plan.LogicalID, plan.Pinned, wantPinned)
		}
	}
}

func TestPlanPublicSurfacesPinnedMiddleSurface(t *testing.T) {
	plans := planPorts(t, portTestSpec(t), 8270, PortPin{LogicalID: "SsrUrl", Port: 8270})
	ports := surfacePorts(plans)
	want := map[string]int{
		"McpHttpApi":               8271,
		"VendingApi":               8272,
		"SsrUrl":                   8270,
		"SocketApi":                8273,
		"ControlPlaneDistribution": 8274,
		"PublicApiDistribution":    8275,
	}
	for id, port := range want {
		if ports[id] != port {
			t.Fatalf("%s port = %d, want %d (allocation %v)", id, ports[id], port, ports)
		}
	}
}

func TestPlanPublicSurfacesEphemeralStaysAutomatic(t *testing.T) {
	plans := planPorts(t, portTestSpec(t), 0)
	for _, plan := range plans {
		if plan.Port != 0 || !plan.Automatic || plan.Pinned {
			t.Fatalf("surface %s = %+v, want an automatic ephemeral port", plan.LogicalID, plan)
		}
	}
}

func TestPlanPublicSurfacesRefusals(t *testing.T) {
	spec := portTestSpec(t)
	cases := []struct {
		name string
		base int
		pins []PortPin
		need string
	}{
		{
			name: "pinning needs a base",
			base: 0,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 8270}},
			need: "--port-base",
		},
		{
			name: "unknown logical id",
			base: 8270,
			pins: []PortPin{{LogicalID: "NotASurface", Port: 8270}},
			need: "serves no public surface with that logical id",
		},
		{
			name: "function is not a listener",
			base: 8270,
			pins: []PortPin{{LogicalID: "Fn", Port: 8270}},
			need: "that is a function, not a public listener",
		},
		{
			name: "duplicate surface",
			base: 8270,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 8270}, {LogicalID: "McpHttpApi", Port: 8271}},
			need: "pinned twice",
		},
		{
			name: "collision",
			base: 8270,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 8270}, {LogicalID: "VendingApi", Port: 8270}},
			need: "collides with",
		},
		{
			name: "below the range",
			base: 8270,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 8269}},
			need: "outside the run's range 8270-8275",
		},
		{
			name: "above the range",
			base: 8270,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 8276}},
			need: "outside the run's range 8270-8275",
		},
		{
			name: "not a tcp port",
			base: 8270,
			pins: []PortPin{{LogicalID: "McpHttpApi", Port: 70000}},
			need: "is not a TCP port",
		},
		{
			name: "range past 65535",
			base: 65531,
			need: "runs past TCP port 65535",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			message := planPortsError(t, spec, testCase.base, testCase.pins...)
			if !strings.Contains(message, testCase.need) {
				t.Fatalf("error %q does not name %q", message, testCase.need)
			}
		})
	}
}

func TestPlanPublicSurfacesRefusesUnservedConstructs(t *testing.T) {
	spec := portTestSpec(t)
	spec.APIs = append(spec.APIs, APISpec{Class: APIHTTPV2, LogicalID: "RouteLessApi"})
	spec.CloudFront = append(spec.CloudFront, &localcloudfront.Distribution{LogicalID: "RefusedDistribution", Refusals: []string{"origin is not local"}})
	cases := []struct {
		id   string
		need string
	}{
		{"RouteLessApi", "serves no route locally"},
		{"RefusedDistribution", "not servable locally"},
	}
	for _, testCase := range cases {
		message := planPortsError(t, spec, 8270, PortPin{LogicalID: testCase.id, Port: 8270})
		if !strings.Contains(message, testCase.need) {
			t.Fatalf("error %q does not name %q", message, testCase.need)
		}
	}
}

func TestParsePortPins(t *testing.T) {
	pins, err := ParsePortPins([]string{"McpHttpApi=8270", " PublicApiDistribution = 8271 "}, 8270)
	if err != nil {
		t.Fatalf("ParsePortPins: %v", err)
	}
	if len(pins) != 2 || pins[0].LogicalID != "McpHttpApi" || pins[0].Port != 8270 ||
		pins[1].LogicalID != "PublicApiDistribution" || pins[1].Port != 8271 {
		t.Fatalf("pins = %+v", pins)
	}
	for _, value := range []string{"McpHttpApi", "=8270", "McpHttpApi=not-a-port"} {
		if _, err := ParsePortPins([]string{value}, 8270); err == nil {
			t.Fatalf("ParsePortPins accepted %q", value)
		}
	}
	if _, err := ParsePortPins([]string{"McpHttpApi=8270"}, 0); err == nil || !strings.Contains(err.Error(), "--port-base") {
		t.Fatalf("ParsePortPins without a base = %v, want a --port-base error", err)
	}
}
