package localcloudfront

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const snapshotDir = "../../cdk/test/snapshots"

func loadSnapshot(t *testing.T, name string) Template {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(snapshotDir, name)) //nolint:gosec // snapshot names come from the checked-in test directory
	if err != nil {
		t.Fatalf("read snapshot %s: %v", name, err)
	}
	var document struct {
		Resources map[string]struct {
			Type       string          `json:"Type"`
			Properties json.RawMessage `json:"Properties"`
		} `json:"Resources"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse snapshot %s: %v", name, err)
	}
	resources := make(map[string]Resource, len(document.Resources))
	for id, resource := range document.Resources {
		resources[id] = Resource{Type: resource.Type, Properties: resource.Properties}
	}
	return Template{Stack: "TestStack", Resources: resources}
}

func snapshotNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(snapshotDir)
	if err != nil {
		t.Fatalf("read snapshot dir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func parseSnapshot(t *testing.T, name string) *Topology {
	t.Helper()
	topology, err := ParseTemplates([]Template{loadSnapshot(t, name)})
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return topology
}

func TestSnapshotTopology(t *testing.T) {
	cases := []struct {
		name         string
		wantServable bool
		behaviors    int
		functions    int
		origins      int
	}{
		{name: "ssr-site.json", wantServable: true, behaviors: 2, functions: 2, origins: 2},
		{name: "ssr-site-facetheory.json", wantServable: true, behaviors: 8, functions: 2, origins: 4},
		{name: "path-routed-frontend-basic.json", wantServable: true, behaviors: 0, functions: 0, origins: 1},
		{name: "path-routed-frontend-multi-spa.json", wantServable: true, behaviors: 3, functions: 1, origins: 3},
		{name: "media-cdn-basic.json", wantServable: true, behaviors: 0, functions: 0, origins: 1},
		{name: "media-cdn-private-keygroup.json", wantServable: true, behaviors: 0, functions: 0, origins: 1},
		{name: "media-cdn-private-pem.json", wantServable: true, behaviors: 0, functions: 0, origins: 1},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			topology := parseSnapshot(t, test.name)
			if len(topology.Distributions) != 1 {
				t.Fatalf("want one distribution, got %d", len(topology.Distributions))
			}
			distribution := topology.Distributions[0]
			if distribution.Servable() != test.wantServable {
				t.Fatalf("servable = %v, want %v (refusals %v)", distribution.Servable(), test.wantServable, distribution.Refusals)
			}
			if test.behaviors > 0 || test.wantServable {
				if got := len(distribution.CacheBehaviors); got != test.behaviors {
					t.Fatalf("cache behaviors = %d, want %d", got, test.behaviors)
				}
				if got := len(distribution.Origins); got != test.origins {
					t.Fatalf("origins = %d, want %d", got, test.origins)
				}
				if got := len(topology.Functions); got != test.functions {
					t.Fatalf("functions = %d, want %d", got, test.functions)
				}
			}
		})
	}
}

func TestSsrSiteFacetheoryOriginGroupAndPath(t *testing.T) {
	topology := parseSnapshot(t, "ssr-site-facetheory.json")
	distribution := topology.Distributions[0]
	if len(distribution.OriginGroups) != 1 {
		t.Fatalf("want one origin group, got %d", len(distribution.OriginGroups))
	}
	group := distribution.OriginGroups[0]
	if len(group.Members) != 2 || group.FailoverStatusCodes[0] != 403 || group.FailoverStatusCodes[1] != 404 {
		t.Fatalf("unexpected origin group: %+v", group)
	}
	if distribution.DefaultBehavior.TargetOriginID != group.ID {
		t.Fatalf("default behavior target = %q, want group %q", distribution.DefaultBehavior.TargetOriginID, group.ID)
	}
	var originPath string
	for _, origin := range distribution.Origins {
		if origin.OriginPath == "/isr-pages" {
			originPath = origin.OriginPath
		}
	}
	if originPath == "" {
		t.Fatal("expected an origin with OriginPath /isr-pages")
	}
}

func TestPathRoutedBehaviorOrderAndRewriteFunction(t *testing.T) {
	topology := parseSnapshot(t, "path-routed-frontend-multi-spa.json")
	distribution := topology.Distributions[0]
	patterns := make([]string, 0, len(distribution.CacheBehaviors))
	for _, behavior := range distribution.CacheBehaviors {
		patterns = append(patterns, behavior.PathPattern)
	}
	want := []string{"/auth/wallet/*", "/l/*", "/auth/*"}
	if strings.Join(patterns, ",") != strings.Join(want, ",") {
		t.Fatalf("behavior order = %v, want %v", patterns, want)
	}
	if distribution.CacheBehaviors[0].ViewerRequestFunction != "" {
		t.Fatal("the API bypass behavior must not run the SPA rewrite")
	}
	if distribution.CacheBehaviors[1].ViewerRequestFunction == "" {
		t.Fatal("the SPA behavior must run the rewrite function")
	}
	if len(topology.Functions) != 1 || topology.Functions[0].Runtime != runtimeJS20 {
		t.Fatalf("unexpected functions: %+v", topology.Functions)
	}
}

func TestPrivateMediaTrustedKeyGroupsAreResolved(t *testing.T) {
	topology := parseSnapshot(t, "media-cdn-private-pem.json")
	distribution := topology.Distributions[0]
	if !distribution.Servable() {
		t.Fatalf("a distribution with a trusted key group must be served: %v", distribution.Refusals)
	}
	behavior := distribution.DefaultBehavior
	if behavior.TrustedKeyGroups == nil || !behavior.TrustedKeyGroups.Enabled {
		t.Fatalf("the behavior must require a signed URL or cookie: %+v", behavior.TrustedKeyGroups)
	}
	if len(topology.PublicKeys) != 1 || len(topology.KeyGroups) != 1 {
		t.Fatalf("want one public key and one key group, got %d/%d", len(topology.PublicKeys), len(topology.KeyGroups))
	}
	if topology.PublicKeys[0].ID == "" {
		t.Fatal("the local public key needs a deterministic Key-Pair-Id")
	}
	if len(topology.KeyGroups[0].Items) != 1 {
		t.Fatalf("key group items = %v", topology.KeyGroups[0].Items)
	}
}

func TestEveryManagedIDUsedByASnapshotIsPinned(t *testing.T) {
	for _, name := range snapshotNames(t) {
		topology := parseSnapshot(t, name)
		for _, distribution := range topology.Distributions {
			for _, behavior := range append([]*Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...) {
				if behavior == nil {
					continue
				}
				for _, policy := range []*Policy{behavior.CachePolicy, behavior.OriginRequestPolicy, behavior.ResponseHeadersPolicy} {
					if policy == nil || !policy.Managed {
						continue
					}
					if _, ok := managedPolicy(policy.ID, policy.Kind); !ok {
						t.Fatalf("%s: managed %s %q is not in the pinned table", name, policy.Kind, policy.ID)
					}
				}
			}
		}
	}
}

func TestSnapshotPropertiesAreInventoried(t *testing.T) {
	inventory := PropertyInventory()
	for _, name := range snapshotNames(t) {
		raw, err := os.ReadFile(filepath.Join(snapshotDir, name)) //nolint:gosec // snapshot names come from the checked-in test directory
		if err != nil {
			t.Fatal(err)
		}
		var document struct {
			Resources map[string]struct {
				Type       string                     `json:"Type"`
				Properties map[string]json.RawMessage `json:"Properties"`
			} `json:"Resources"`
		}
		if err := json.Unmarshal(raw, &document); err != nil {
			t.Fatal(err)
		}
		for id, resource := range document.Resources {
			switch resource.Type {
			case typeCloudFrontDistribution:
				config, err := decodeObject(resource.Properties["DistributionConfig"])
				if err != nil {
					t.Fatalf("%s/%s: %v", name, id, err)
				}
				assertInventoried(t, name, id, "DistributionConfig", config, inventory["DistributionConfig"])
				for _, behaviorKey := range []string{"DefaultCacheBehavior", "CacheBehaviors"} {
					if rawBehavior, ok := config[behaviorKey]; ok {
						if behaviorKey == "DefaultCacheBehavior" {
							behavior, err := decodeObject(rawBehavior)
							if err != nil {
								t.Fatal(err)
							}
							assertInventoried(t, name, id, "CacheBehavior", behavior, inventory["CacheBehavior"])
						} else {
							var behaviors []json.RawMessage
							if err := json.Unmarshal(rawBehavior, &behaviors); err != nil {
								t.Fatal(err)
							}
							for _, rawObj := range behaviors {
								behavior, err := decodeObject(rawObj)
								if err != nil {
									t.Fatal(err)
								}
								assertInventoried(t, name, id, "CacheBehavior", behavior, inventory["CacheBehavior"])
							}
						}
					}
				}
				if rawOrigins, ok := config["Origins"]; ok {
					var origins []json.RawMessage
					if err := json.Unmarshal(rawOrigins, &origins); err != nil {
						t.Fatal(err)
					}
					for _, rawObj := range origins {
						origin, err := decodeObject(rawObj)
						if err != nil {
							t.Fatal(err)
						}
						assertInventoried(t, name, id, "Origin", origin, inventory["Origin"])
					}
				}
			case typeCloudFrontFunction:
				assertInventoried(t, name, id, "Function", resource.Properties, inventory["Function"])
			case typeCachePolicy:
				assertInventoried(t, name, id, "CachePolicyConfig", mustObject(t, resource.Properties["CachePolicyConfig"]), inventory["CachePolicyConfig"])
			case typeOriginRequestPolicy:
				assertInventoried(t, name, id, "OriginRequestPolicyConfig", mustObject(t, resource.Properties["OriginRequestPolicyConfig"]), inventory["OriginRequestPolicyConfig"])
			case typeResponseHeadersPolicy:
				assertInventoried(t, name, id, "ResponseHeadersPolicyConfig", mustObject(t, resource.Properties["ResponseHeadersPolicyConfig"]), inventory["ResponseHeadersPolicyConfig"])
			case typeOriginAccessControl:
				assertInventoried(t, name, id, "OriginAccessControlConfig", mustObject(t, resource.Properties["OriginAccessControlConfig"]), inventory["OriginAccessControlConfig"])
			}
		}
	}
}

func mustObject(t *testing.T, raw json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	value, err := decodeObject(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertInventoried(t *testing.T, file, id, context string, properties map[string]json.RawMessage, inventory map[string]Disposition) {
	t.Helper()
	for key := range properties {
		if _, ok := inventory[key]; !ok {
			t.Fatalf("%s/%s: %s property %q is missing from the inventory", file, id, context, key)
		}
	}
}
