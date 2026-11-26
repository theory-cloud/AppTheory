package naming

import (
	"encoding/json"
	"strings"
	"testing"
)

// Hosted namespaces (contract section 1 r5 rev1, section 2, section 2.4 and
// section 4 hosted pins). The cases below are the actor/state scenarios of the
// AT-N5 milestone, one test per scenario, so every runtime surface can be
// compared line for line.

func hostedContext(namespace string) Context {
	return Context{
		Namespace: namespace,
		App:       "shop",
		Stage:     "lab",
		Account:   "123456789012",
		Region:    "us-east-1",
		Hosted:    true,
	}
}

// Scenario 1: a first-party platform app keeps every r4 name byte for byte, so
// the live compatibility profile (contract section 4) is unchanged.
func TestHostedScenario1PlatformAppKeepsR4Names(t *testing.T) {
	platform := Context{
		App:     "theory-mcp-server",
		Stage:   "lab",
		Account: "191637461429",
		Region:  "us-east-1",
	}
	expected := map[string]ComposedName{
		"lambda_function:worker": {
			Name: "theory-mcp-server-lab-worker",
		},
		"dynamodb_table:events": {
			Name: "theory-mcp-server-lab-events",
		},
		"s3_bucket:media": {
			Name:             "theory-mcp-server-lab-media-191637461429-us-east-1-an",
			BucketNamePrefix: "theory-mcp-server-lab-media",
			BucketNamespace:  "account-regional",
		},
		"secret:provider/stripe": {
			Name: "theory-mcp-server/lab/provider/stripe",
		},
		"ssm_parameter:config": {
			Name: "/theory-mcp-server/lab/config",
		},
		"kms_alias:data": {
			Name: "alias/theory-mcp-server/lab/data",
		},
		"log_group:logs/runtime/api": {
			Name: "theorycloud_theorycloud_theory-mcp-server_lab_logs_runtime_api",
		},
	}
	for key, want := range expected {
		resourceType, logical, found := strings.Cut(key, ":")
		if !found {
			t.Fatalf("bad case key %q", key)
		}
		got, err := PhysicalName(platform, resourceType, logical, nil, nil)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if got != want {
			t.Fatalf("%s: got %+v, want %+v", key, got, want)
		}
	}

	// An explicit platform namespace and an omitted one are the same context,
	// so both keep the r4 form and the non-hosted path stays namespaced=false.
	explicit := platform
	explicit.Namespace = LogPrefix
	if namespaced(platform) || namespaced(explicit) {
		t.Fatal("a platform app is not namespaced")
	}
	omitted, err := PhysicalName(platform, "lambda_function", "worker", nil, nil)
	if err != nil {
		t.Fatalf("platform lambda: %v", err)
	}
	withNamespace, err := PhysicalName(explicit, "lambda_function", "worker", nil, nil)
	if err != nil {
		t.Fatalf("explicit platform lambda: %v", err)
	}
	if omitted != withNamespace {
		t.Fatalf("omitted and explicit platform namespace differ: %+v != %+v", omitted, withNamespace)
	}

	// The pins and generated entries a platform app relies on today still apply.
	pinned, err := PhysicalName(explicit, "lambda_function", "worker", map[string]string{
		"lambda_function:worker": "theory-mcp-server-lab-worker-v1",
	}, nil)
	if err != nil {
		t.Fatalf("platform pin: %v", err)
	}
	if !pinned.Pinned || pinned.Name != "theory-mcp-server-lab-worker-v1" {
		t.Fatalf("platform pin: %+v", pinned)
	}
	legacy := explicit
	legacy.NamingProfile = NamingProfileLegacy
	generated, err := PhysicalName(legacy, "dynamodb_table", "events", nil, []string{"dynamodb_table:events"})
	if err != nil {
		t.Fatalf("platform generated entry: %v", err)
	}
	if !generated.Generated {
		t.Fatalf("platform generated entry: %+v", generated)
	}
}

// Scenario 2: a hosted deployment carries its namespace in every derived name,
// reaches the shortened over-budget form sooner (section 2.4) and leaves
// log-source names unchanged (section 3).
func TestHostedScenario2HostedForms(t *testing.T) {
	cases := []struct {
		context      Context
		resourceType string
		logical      string
		want         ComposedName
	}{
		{
			// section 2.4: acme/shop/lab lambda worker fits.
			hostedContext("acme"), "lambda_function", "worker",
			ComposedName{Name: "acme-shop-lab-worker"},
		},
		{
			hostedContext("acme"), "dynamodb_table", "orders",
			ComposedName{Name: "acme-shop-lab-orders"},
		},
		{
			// section 2.1: the S3 prefix carries the namespace and stays inside
			// the 37-character budget a 12-digit account leaves in us-east-1.
			hostedContext("acme"), "s3_bucket", "uploads",
			ComposedName{
				Name:             "acme-shop-lab-uploads-123456789012-us-east-1-an",
				BucketNamePrefix: "acme-shop-lab-uploads",
				BucketNamespace:  "account-regional",
			},
		},
		{
			// section 2.4: the hosted stem makes this prefix over budget, so the
			// shortened form applies to the prefix.
			Context{
				Namespace: "acme", App: "storefront-checkout", Stage: "lab",
				Account: "123456789012", Region: "us-east-1", Hosted: true,
			}, "s3_bucket", "customer-uploads-archive",
			ComposedName{
				Name:             "acme-storefront-checkout-lab-5cs2pek2-123456789012-us-east-1-an",
				BucketNamePrefix: "acme-storefront-checkout-lab-5cs2pek2",
				BucketNamespace:  "account-regional",
			},
		},
		{
			// section 2.4: a dash name over its 64-character limit.
			Context{
				Namespace: "northwind", App: "customer-portal-analytics", Stage: "lab",
				Account: "123456789012", Region: "us-east-1", Hosted: true,
			}, "iam_role", "keeper-reader-cross-account",
			ComposedName{Name: "northwind-customer-portal-analytics-lab-keeper-reader-c-r3njssl4"},
		},
		{
			// section 2: path names carry the namespace after the lead.
			hostedContext("acme"), "secret", "provider/stripe",
			ComposedName{Name: "acme/shop/lab/provider/stripe"},
		},
		{
			hostedContext("acme"), "ssm_parameter", "config/feature-flags",
			ComposedName{Name: "/acme/shop/lab/config/feature-flags"},
		},
		{
			hostedContext("acme"), "kms_alias", "data",
			ComposedName{Name: "alias/acme/shop/lab/data"},
		},
		{
			// section 3: log-source names already carry the namespace and do not
			// change.
			hostedContext("acme"), "log_group", "logs/runtime/api",
			ComposedName{Name: "theorycloud_acme_shop_lab_logs_runtime_api"},
		},
	}
	for _, tc := range cases {
		got, err := PhysicalName(tc.context, tc.resourceType, tc.logical, nil, nil)
		if err != nil {
			t.Fatalf("%s/%s: %v", tc.resourceType, tc.logical, err)
		}
		if got != tc.want {
			t.Fatalf("%s/%s: got %+v, want %+v", tc.resourceType, tc.logical, got, tc.want)
		}
	}

	// A hosted pin is returned verbatim when it starts with its namespace
	// component, exactly where the derived form puts it.
	pinned, err := PhysicalName(hostedContext("acme"), "dynamodb_table", "events", map[string]string{
		"dynamodb_table:events": "acme-shop-lab-events-v1",
	}, nil)
	if err != nil {
		t.Fatalf("hosted pin: %v", err)
	}
	if !pinned.Pinned || pinned.Name != "acme-shop-lab-events-v1" {
		t.Fatalf("hosted pin: %+v", pinned)
	}
	for _, tc := range []struct {
		resourceType string
		logical      string
		pin          string
	}{
		{"ssm_parameter", "config", "/acme/shop/lab/config-v2"},
		{"kms_alias", "data", "alias/acme/shop/lab/data-v2"},
		{"log_group", "logs/runtime/api", "theorycloud_acme_shop_lab_logs_runtime_api"},
	} {
		if _, err := PhysicalName(hostedContext("acme"), tc.resourceType, tc.logical, map[string]string{
			tc.resourceType + ":" + tc.logical: tc.pin,
		}, nil); err != nil {
			t.Fatalf("%s pin %q: %v", tc.resourceType, tc.pin, err)
		}
	}
}

// Scenario 3: every hosted context that breaks a rule is refused at synth, and
// the refusal names the rule it broke.
func TestHostedScenario3Refusals(t *testing.T) {
	cases := []struct {
		name    string
		context Context
		pins    map[string]string
		want    string
	}{
		{
			"missing namespace",
			Context{App: "shop", Stage: "lab", Account: "123456789012", Region: "us-east-1", Hosted: true},
			nil,
			"a hosted deployment must supply its namespace",
		},
		{
			"empty namespace",
			Context{Namespace: "", App: "shop", Stage: "lab", Account: "123456789012", Region: "us-east-1", Hosted: true},
			nil,
			"a hosted deployment must supply its namespace",
		},
		{
			"namespace over 12 characters",
			hostedContext("northwind-trade"),
			nil,
			"hosted namespace longer than 12 characters",
		},
		{
			"namespace starts with aws",
			hostedContext("awsome"),
			nil,
			"hosted namespace must not start with aws or ssm",
		},
		{
			"namespace starts with ssm",
			hostedContext("ssmtools"),
			nil,
			"hosted namespace must not start with aws or ssm",
		},
		{
			"reserved platform namespace",
			hostedContext(LogPrefix),
			nil,
			"namespace theorycloud is reserved for first-party platform apps",
		},
		{
			"hosted pin without the namespace component",
			hostedContext("acme"),
			map[string]string{"dynamodb_table:events": "shop-lab-events"},
			"a hosted pin must start with the namespace component",
		},
		{
			// `shop-lab-events` is not a pin for namespace `hop`: containing the
			// namespace somewhere in the name is not enough (r5 rev2).
			"hosted pin with the namespace as a substring only",
			hostedContext("hop"),
			map[string]string{"dynamodb_table:events": "shop-lab-events"},
			"a hosted pin must start with the namespace component",
		},
	}
	for _, tc := range cases {
		_, err := PhysicalName(tc.context, "dynamodb_table", "events", tc.pins, nil)
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%s: want %q, got %v", tc.name, tc.want, err)
		}
		if err := ValidateContext(tc.context); err == nil && !strings.Contains(tc.want, "pin") {
			t.Fatalf("%s: ValidateContext accepted the context", tc.name)
		}
	}

	// The two live-compatibility tools are first-party only (section 4 r5 rev2).
	legacy := hostedContext("acme")
	legacy.NamingProfile = NamingProfileLegacy
	if _, err := PhysicalName(legacy, "dynamodb_table", "events", map[string]string{
		"dynamodb_table:events": "acme-shop-lab-events",
	}, nil); err == nil || err.Error() != "a hosted deployment takes no legacy profile or generated entries" {
		t.Fatalf("hosted legacy profile: %v", err)
	}
	if _, err := PhysicalName(legacy, "dynamodb_table", "events", nil, []string{
		"dynamodb_table:events",
	}); err == nil || err.Error() != "a hosted deployment takes no legacy profile or generated entries" {
		t.Fatalf("hosted generated entry: %v", err)
	}

	// The lambda service path is not a hosted log source either: a hosted pin
	// must carry `theorycloud_{namespace}_`.
	if _, err := PhysicalName(hostedContext("acme"), "log_group", "logs/runtime/api", map[string]string{
		"log_group:logs/runtime/api": "/aws/lambda/acme-shop-lab-worker",
	}, nil); err == nil || err.Error() != "a hosted pin must start with the namespace component" {
		t.Fatalf("hosted log-group pin: %v", err)
	}
}

// Scenario 4: two namespaces in one account, same app, stage and logical name,
// derive distinct names.
func TestHostedScenario4TwoNamespacesStayDistinct(t *testing.T) {
	acme, err := PhysicalName(hostedContext("acme"), "lambda_function", "worker", nil, nil)
	if err != nil {
		t.Fatalf("acme: %v", err)
	}
	globex, err := PhysicalName(hostedContext("globex"), "lambda_function", "worker", nil, nil)
	if err != nil {
		t.Fatalf("globex: %v", err)
	}
	if acme.Name != "acme-shop-lab-worker" || globex.Name != "globex-shop-lab-worker" {
		t.Fatalf("unexpected names %q and %q", acme.Name, globex.Name)
	}
	if acme.Name == globex.Name {
		t.Fatal("two namespaces in one account derived one name")
	}

	// The synthetic section 11.4 artifact carries the hosted names, so the
	// reservation index reserves the namespaced forms and never collides.
	artifact, err := SynthCheck([]NameEntry{
		{Name: acme.Name, Type: "lambda_function", LogicalID: "AcmeWorker"},
		{Name: globex.Name, Type: "lambda_function", LogicalID: "GlobexWorker"},
	})
	if err != nil {
		t.Fatalf("artifact: %v", err)
	}
	if len(artifact) != 2 || artifact[0].Name != acme.Name || artifact[1].Name != globex.Name {
		t.Fatalf("unexpected artifact %+v", artifact)
	}
}

// Scenario 5: AppTheory does not resolve or choose the account or Region. They
// are naming inputs the caller supplies (TheoryCloud.ai injects them for a
// hosted deployment), an unresolved token still fails synth, and nothing is
// read from the environment.
func TestHostedScenario5EnvironmentIsACallerInput(t *testing.T) {
	t.Setenv("AWS_ACCOUNT_ID", "999999999999")
	t.Setenv("AWS_REGION", "ap-southeast-2")
	t.Setenv("AWS_DEFAULT_REGION", "ap-southeast-2")
	t.Setenv("NAMESPACE", "globex")
	t.Setenv("APP_THEORY_NAMESPACE", "globex")
	t.Setenv("THEORYCLOUD_NAMESPACE", "globex")

	got, err := PhysicalName(hostedContext("acme"), "s3_bucket", "uploads", nil, nil)
	if err != nil {
		t.Fatalf("hosted s3: %v", err)
	}
	if got.Name != "acme-shop-lab-uploads-123456789012-us-east-1-an" {
		t.Fatalf("environment leaked into the name: %q", got.Name)
	}

	// An unresolved CDK token is not a concrete account or Region, so synth
	// fails instead of deferring a deploy-time name.
	for name, ctx := range map[string]Context{
		"unresolved account": {Namespace: "acme", App: "shop", Stage: "lab", Account: "${Token[TOKEN.1]}", Region: "us-east-1", Hosted: true},
		"unresolved region":  {Namespace: "acme", App: "shop", Stage: "lab", Account: "123456789012", Region: "${Token[TOKEN.2]}", Hosted: true},
		"empty account":      {Namespace: "acme", App: "shop", Stage: "lab", Account: "", Region: "us-east-1", Hosted: true},
		"empty region":       {Namespace: "acme", App: "shop", Stage: "lab", Account: "123456789012", Region: "", Hosted: true},
	} {
		if err := ValidateContext(ctx); err == nil {
			t.Fatalf("%s: context accepted", name)
		}
	}

	// The namespace label rule applies to any non-platform namespace, hosted or
	// not, because only the reserved platform namespace keeps the r4 form.
	nonHosted := Context{Namespace: "northwind-trade", App: "shop", Stage: "lab", Account: "123456789012", Region: "us-east-1"}
	if err := ValidateContext(nonHosted); err == nil || err.Error() != "hosted namespace longer than 12 characters" {
		t.Fatalf("non-platform namespace over 12 characters: %v", err)
	}
}

// The hosted flag survives the context's own JSON decoding, because a fixture or
// a stage config reaches the context through it.
func TestHostedContextDecodes(t *testing.T) {
	var ctx Context
	raw := []byte(`{"namespace":"acme","app":"shop","stage":"lab","account":"123456789012","region":"us-east-1","hosted":true}`)
	if err := json.Unmarshal(raw, &ctx); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !ctx.Hosted {
		t.Fatal("hosted was not decoded")
	}
	name, err := PhysicalName(ctx, "lambda_function", "worker", nil, nil)
	if err != nil {
		t.Fatalf("hosted decode: %v", err)
	}
	if name.Name != "acme-shop-lab-worker" {
		t.Fatalf("hosted decode: %+v", name)
	}

	// A platform context omits the flag, and an explicit false is the same.
	for _, raw := range [][]byte{
		[]byte(`{"app":"shop","stage":"lab","account":"123456789012","region":"us-east-1"}`),
		[]byte(`{"app":"shop","stage":"lab","account":"123456789012","region":"us-east-1","hosted":false}`),
	} {
		var platform Context
		if err := json.Unmarshal(raw, &platform); err != nil {
			t.Fatalf("decode platform: %v", err)
		}
		if platform.Hosted {
			t.Fatalf("platform context decoded as hosted: %s", raw)
		}
		name, err := PhysicalName(platform, "lambda_function", "worker", nil, nil)
		if err != nil {
			t.Fatalf("platform decode: %v", err)
		}
		if name.Name != "shop-lab-worker" {
			t.Fatalf("platform decode: %+v", name)
		}
	}
}

// Scenario 3b (SAN-AT-N5-01): the legacy profile is a property of the context,
// so a hosted context is refused when the context is validated — with no naming
// declarations at all, and with only a log-source name — not only when a
// construct composes a physical name. The refusal names the hosted reason, and
// the two accepting controls stay as they were.
func TestHostedScenario3bProfileRefusedWithoutAComposedName(t *testing.T) {
	const want = "a hosted deployment takes no legacy profile or generated entries"
	legacy := hostedContext("acme")
	legacy.NamingProfile = NamingProfileLegacy

	// No declarations: the context is the only naming input, and it is refused.
	if err := ValidateContext(legacy); err == nil || err.Error() != want {
		t.Fatalf("no declarations: want %q, got %v", want, err)
	}

	// A log-only declaration: the log-source path refuses too, so a context the
	// profile rule rejects cannot produce a name there either.
	if name, err := LogGroupName(legacy, "logs/runtime/api"); err == nil || err.Error() != want {
		t.Fatalf("log-only declaration: want %q, got %q / %v", want, name, err)
	}

	// A composed name keeps refusing, on the same reason.
	if _, err := PhysicalName(legacy, "dynamodb_table", "events", map[string]string{
		"dynamodb_table:events": "acme-shop-lab-events",
	}, nil); err == nil || err.Error() != want {
		t.Fatalf("composed name: want %q, got %v", want, err)
	}

	// Control: the valid derived hosted context still validates, still resolves a
	// log source, and still composes the hosted name.
	derived := hostedContext("acme")
	if err := ValidateContext(derived); err != nil {
		t.Fatalf("derived hosted context: %v", err)
	}
	logName, err := LogGroupName(derived, "logs/runtime/api")
	if err != nil {
		t.Fatalf("derived hosted log source: %v", err)
	}
	if logName != "theorycloud_acme_shop_lab_logs_runtime_api" {
		t.Fatalf("derived hosted log source: %q", logName)
	}
	if name, err := PhysicalName(derived, "lambda_function", "worker", nil, nil); err != nil {
		t.Fatalf("derived hosted name: %v", err)
	} else if name.Name != "acme-shop-lab-worker" {
		t.Fatalf("derived hosted name: %+v", name)
	}

	// Control: the platform app keeps the legacy profile, exactly as r4 allowed
	// (contract section 4), so the platform path is not narrowed.
	platform := labContext()
	platform.NamingProfile = NamingProfileLegacy
	if err := ValidateContext(platform); err != nil {
		t.Fatalf("platform legacy context: %v", err)
	}
	if name, err := PhysicalName(platform, "dynamodb_table", "events", map[string]string{
		"dynamodb_table:events": "autheory-lab-events",
	}, nil); err != nil {
		t.Fatalf("platform legacy name: %v", err)
	} else if name.Name != "autheory-lab-events" {
		t.Fatalf("platform legacy name: %+v", name)
	}
	if name, err := LogGroupName(platform, "logs/runtime/api"); err != nil {
		t.Fatalf("platform log source: %v", err)
	} else if name != "theorycloud_theorycloud_autheory_lab_logs_runtime_api" {
		t.Fatalf("platform log source: %q", name)
	}
}
