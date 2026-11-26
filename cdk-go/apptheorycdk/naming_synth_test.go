package apptheorycdk

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/aws/aws-cdk-go/awscdk/v2"
	"github.com/aws/aws-cdk-go/awscdk/v2/awslambda"
	"github.com/aws/jsii-runtime-go"
)

// These tests drive the generated Go binding through the jsii kernel, so the
// contract section 11.4 surface is proved in Go and not only in TypeScript
// (r4, SANITY-AT-N3-04). Each test synthesizes a real cloud assembly: the
// refusal is the error the kernel raises, and the artifact is the metadata
// document in `{stack}.metadata.json`.

const derivedNamesMetadataKey = "apptheory:resource-naming/derived-names"

var logicalIDPattern = regexp.MustCompile(`[A-Za-z0-9]+(?:Function|LogGroup|Bucket|Table|Parameter)[0-9A-F]{8}`)

type metadataEntry struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type cloudAssemblyTemplate struct {
	Resources map[string]json.RawMessage `json:"Resources"`
}

func namingTestContext(stack awscdk.Stack) AppTheoryNamingContext {
	return NewAppTheoryNamingContext(stack, jsii.String("Naming"), &AppTheoryNamingContextProps{
		App:     jsii.String("shop"),
		Stage:   jsii.String("lab"),
		Account: jsii.String("998115851393"),
		Region:  jsii.String("us-east-1"),
	})
}

func namingTestFunction(stack awscdk.Stack, id string, logical string, context AppTheoryNamingContext) {
	NewAppTheoryFunction(stack, jsii.String(id), &AppTheoryFunctionProps{
		NamingContext: context,
		LogicalName:   jsii.String(logical),
		Code:          awslambda.Code_FromInline(jsii.String("exports.handler = async () => ({ statusCode: 204 });")),
		Runtime:       awslambda.Runtime_NODEJS_24_X(),
		Handler:       jsii.String("index.handler"),
	})
}

func namingTestStack(app awscdk.App, id string) awscdk.Stack {
	return awscdk.NewStack(app, jsii.String(id), &awscdk.StackProps{
		Env: &awscdk.Environment{Account: jsii.String("998115851393"), Region: jsii.String("us-east-1")},
	})
}

// synthNamingApp synthesizes one stack and reports the kernel error as a value,
// because a validation failure reaches Go as a panic.
func synthNamingApp(t *testing.T, build func(stack awscdk.Stack)) (outdir string, synthErr error) {
	t.Helper()
	outdir = t.TempDir()
	var failure error
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				synthFailure, isError := recovered.(error)
				if !isError {
					synthFailure = &namingSynthPanic{value: recovered}
				}
				failure = synthFailure
			}
		}()
		app := awscdk.NewApp(&awscdk.AppProps{Outdir: jsii.String(outdir)})
		stack := namingTestStack(app, "Stack")
		build(stack)
		app.Synth(nil)
	}()
	return outdir, failure
}

type namingSynthPanic struct{ value any }

func (p *namingSynthPanic) Error() string { return "synthesis panicked" }

func artifactDocuments(t *testing.T, metadataPath string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatalf("read %s: %v", metadataPath, err)
	}
	// `{stack}.metadata.json` maps a construct path to its metadata entries.
	var document map[string][]metadataEntry
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("parse %s: %v", metadataPath, err)
	}
	documents := make([]map[string]any, 0, 1)
	for _, entries := range document {
		for _, entry := range entries {
			if entry.Type != derivedNamesMetadataKey {
				continue
			}
			var artifact map[string]any
			if err := json.Unmarshal(entry.Data, &artifact); err != nil {
				t.Fatalf("parse the derived-name document in %s: %v", metadataPath, err)
			}
			documents = append(documents, artifact)
		}
	}
	return documents
}

func stackTemplate(t *testing.T, templatePath string) cloudAssemblyTemplate {
	t.Helper()
	data, err := os.ReadFile(templatePath)
	if err != nil {
		t.Fatalf("read %s: %v", templatePath, err)
	}
	var template cloudAssemblyTemplate
	if err := json.Unmarshal(data, &template); err != nil {
		t.Fatalf("parse %s: %v", templatePath, err)
	}
	return template
}

func artifactRows(t *testing.T, document map[string]any) []map[string]any {
	t.Helper()
	rawEntries, ok := document["entries"].([]any)
	if !ok {
		t.Fatalf("artifact has no entries: %v", document)
	}
	rows := make([]map[string]any, 0, len(rawEntries))
	for _, raw := range rawEntries {
		row, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("artifact row is not an object: %v", raw)
		}
		rows = append(rows, row)
	}
	return rows
}

func TestNamingContextBindingRefusesSameScopeDuplicate(t *testing.T) {
	_, err := synthNamingApp(t, func(stack awscdk.Stack) {
		context := namingTestContext(stack)
		// `site/status` and `site-status` both compose shop-lab-site-status, the
		// separator ambiguity the r4 contract exists to catch.
		namingTestFunction(stack, "Slash", "site/status", context)
		namingTestFunction(stack, "Dash", "site-status", context)
	})
	if err == nil {
		t.Fatal("two logical resources deriving one name in one scope must fail synthesis")
	}
	message := err.Error()
	if !strings.Contains(message, "derive shop-lab-site-status in scope account_region") {
		t.Fatalf("refusal must name the name and the scope: %s", message)
	}
	ids := logicalIDPattern.FindAllString(message, -1)
	if len(ids) != 2 || ids[0] == ids[1] {
		t.Fatalf("refusal must name both CloudFormation logical ids: %s", message)
	}
	for _, id := range ids {
		if !strings.HasPrefix(id, "SlashFunction") && !strings.HasPrefix(id, "DashFunction") {
			t.Fatalf("unexpected logical id %q in %s", id, message)
		}
	}
	if !strings.Contains(message, "two different logical resources in one naming context cannot share a physical name") {
		t.Fatalf("refusal must explain the rule: %s", message)
	}
}

func TestNamingContextBindingEmitsDerivedNameArtifact(t *testing.T) {
	outdir, err := synthNamingApp(t, func(stack awscdk.Stack) {
		context := namingTestContext(stack)
		namingTestFunction(stack, "Worker", "worker", context)
		NewAppTheoryKeeperVisibility(stack, jsii.String("Visibility"), &AppTheoryKeeperVisibilityProps{
			NamingContext:      context,
			ReaderPrincipalArn: jsii.String("arn:aws:iam::123456789012:role/cloud-keeper"),
			Rules:              &AppTheoryVisibilityRules{},
		})
	})
	if err != nil {
		t.Fatalf("synthesis failed: %v", err)
	}

	documents := artifactDocuments(t, filepath.Join(outdir, "Stack.metadata.json"))
	if len(documents) != 1 {
		t.Fatalf("want one derived-name document, got %d", len(documents))
	}
	document := documents[0]
	if document["contract"] != "theorycloud_resource_naming.v0.1" {
		t.Fatalf("unexpected contract %v", document["contract"])
	}
	if document["schema"] != "apptheory_resource_naming.derived_names.v1" {
		t.Fatalf("unexpected schema %v", document["schema"])
	}
	context, ok := document["context"].(map[string]any)
	if !ok ||
		context["app"] != "shop" ||
		context["stage"] != "lab" ||
		context["account"] != "998115851393" ||
		context["region"] != "us-east-1" {
		t.Fatalf("unexpected bound context %v", document["context"])
	}

	rows := artifactRows(t, document)
	got := make([]string, 0, len(rows))
	for _, row := range rows {
		got = append(got, row["type"].(string)+"|"+row["name"].(string)+"|"+row["scope"].(string))
	}
	want := []string{
		"iam_role|shop-lab-keeper-reader|account",
		"iam_role|shop-lab-worker|account",
		"lambda_function|shop-lab-worker|account_region",
		"log_group|/aws/lambda/shop-lab-worker|account_region",
		"ssm_parameter|/theorycloud/visibility/shop/lab/manifest|account_region",
	}
	if len(got) != len(want) {
		t.Fatalf("artifact rows %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("artifact rows %v, want %v", got, want)
		}
	}

	// Every row names a resource this stack's own template holds.
	template := stackTemplate(t, filepath.Join(outdir, "Stack.template.json"))
	for _, row := range rows {
		logicalID, ok := row["logical_id"].(string)
		if _, present := template.Resources[logicalID]; !ok || !present {
			t.Fatalf("row logical id %v is not in the stack template", row["logical_id"])
		}
	}
}

func TestNamingContextBindingStackAttribution(t *testing.T) {
	// A context in one stack used by a construct in another must attribute the
	// entry to the stack that holds the logical id (F2 / SANITY-AT-N3-02).
	outdir := t.TempDir()
	app := awscdk.NewApp(&awscdk.AppProps{Outdir: jsii.String(outdir)})
	owner := namingTestStack(app, "Owner")
	consumer := namingTestStack(app, "Consumer")
	context := namingTestContext(owner)
	NewAppTheoryBucket(owner, jsii.String("Assets"), &AppTheoryBucketProps{
		NamingContext: context,
		Logical:       jsii.String("site-assets"),
	})
	namingTestFunction(consumer, "Worker", "worker", context)
	app.Synth(nil)

	consumerDocuments := artifactDocuments(t, filepath.Join(outdir, "Consumer.metadata.json"))
	if len(consumerDocuments) != 1 {
		t.Fatalf("the consumer stack must carry its own derived-name document, got %d", len(consumerDocuments))
	}
	consumerRows := artifactRows(t, consumerDocuments[0])
	if len(consumerRows) == 0 {
		t.Fatal("the consumer document must describe the consumer's resources")
	}
	consumerTemplate := stackTemplate(t, filepath.Join(outdir, "Consumer.template.json"))
	for _, row := range consumerRows {
		logicalID := row["logical_id"].(string)
		if _, ok := consumerTemplate.Resources[logicalID]; !ok {
			t.Fatalf("row %s is not in the consumer stack template", logicalID)
		}
	}

	ownerDocuments := artifactDocuments(t, filepath.Join(outdir, "Owner.metadata.json"))
	if len(ownerDocuments) != 1 {
		t.Fatalf("the owner stack must carry its own derived-name document, got %d", len(ownerDocuments))
	}
	ownerTemplate := stackTemplate(t, filepath.Join(outdir, "Owner.template.json"))
	ownerRows := artifactRows(t, ownerDocuments[0])
	if len(ownerRows) != 1 || ownerRows[0]["type"] != "s3_bucket" {
		t.Fatalf("the owner document must describe only the owner's bucket: %v", ownerRows)
	}
	for _, row := range ownerRows {
		logicalID := row["logical_id"].(string)
		if _, ok := ownerTemplate.Resources[logicalID]; !ok {
			t.Fatalf("row %s is not in the owner stack template", logicalID)
		}
		if _, claimed := consumerTemplate.Resources[logicalID]; claimed {
			t.Fatalf("the owner must not claim the consumer's resource %s", logicalID)
		}
	}
}

// hostedNamingTestContext is a hosted deployment's context: TheoryCloud.ai has
// set `hosted` and the tenant namespace, and injected the account and Region
// from its own placement (contract section 1, r5).
func hostedNamingTestContext(stack awscdk.Stack) AppTheoryNamingContext {
	return NewAppTheoryNamingContext(stack, jsii.String("Naming"), &AppTheoryNamingContextProps{
		Namespace: jsii.String("acme"),
		Hosted:    jsii.Bool(true),
		App:       jsii.String("shop"),
		Stage:     jsii.String("lab"),
		Account:   jsii.String("998115851393"),
		Region:    jsii.String("us-east-1"),
	})
}

func TestNamingContextBindingHostedNames(t *testing.T) {
	// R5: the hosted surface reaches Go through the jsii binding, so a Go CDK
	// consumer derives the namespaced names and emits the artifact that carries
	// them (contract sections 2 and 11.4, r5).
	outdir, synthErr := synthNamingApp(t, func(stack awscdk.Stack) {
		context := hostedNamingTestContext(stack)
		namingTestFunction(stack, "Worker", "worker", context)
	})
	if synthErr != nil {
		t.Fatalf("a hosted context must synthesize: %v", synthErr)
	}

	documents := artifactDocuments(t, filepath.Join(outdir, "Stack.metadata.json"))
	if len(documents) != 1 {
		t.Fatalf("want exactly one derived-name document, got %d", len(documents))
	}
	document := documents[0]
	context, ok := document["context"].(map[string]any)
	if !ok {
		t.Fatalf("artifact has no context: %v", document)
	}
	if got := context["namespace"]; got != "acme" {
		t.Fatalf("the artifact records the tenant namespace, got %v", got)
	}

	var lambdaRow, roleRow map[string]any
	for _, row := range artifactRows(t, document) {
		switch row["type"] {
		case "lambda_function":
			lambdaRow = row
		case "iam_role":
			roleRow = row
		}
	}
	if lambdaRow == nil || roleRow == nil {
		t.Fatalf("the artifact must carry the Lambda function and its role: %v", document)
	}
	if got := lambdaRow["name"]; got != "acme-shop-lab-worker" {
		t.Fatalf("hosted Lambda name = %v", got)
	}
	if got := roleRow["name"]; got != "acme-shop-lab-worker" {
		t.Fatalf("hosted role name = %v", got)
	}

	// The template carries the same names, so the artifact and the resources
	// agree.
	template := stackTemplate(t, filepath.Join(outdir, "Stack.template.json"))
	for _, raw := range template.Resources {
		var resource struct {
			Type       string `json:"Type"`
			Properties struct {
				FunctionName any `json:"FunctionName"`
				RoleName     any `json:"RoleName"`
			} `json:"Properties"`
		}
		if err := json.Unmarshal(raw, &resource); err != nil {
			t.Fatalf("parse a template resource: %v", err)
		}
		switch resource.Type {
		case "AWS::Lambda::Function":
			if resource.Properties.FunctionName != "acme-shop-lab-worker" {
				t.Fatalf("FunctionName = %v", resource.Properties.FunctionName)
			}
		case "AWS::IAM::Role":
			if resource.Properties.RoleName != "acme-shop-lab-worker" {
				t.Fatalf("RoleName = %v", resource.Properties.RoleName)
			}
		}
	}
}

func TestNamingContextBindingHostedRefusals(t *testing.T) {
	// R2 in Go through the binding: each broken hosted context is refused at
	// synthesis, and the refusal names its reason.
	cases := map[string]struct {
		props   *AppTheoryNamingContextProps
		pattern string
	}{
		"missing namespace": {
			props: &AppTheoryNamingContextProps{
				Hosted: jsii.Bool(true), App: jsii.String("shop"), Stage: jsii.String("lab"),
				Account: jsii.String("998115851393"), Region: jsii.String("us-east-1"),
			},
			pattern: "requires a namespace for a hosted deployment",
		},
		"namespace over 12 characters": {
			props: &AppTheoryNamingContextProps{
				Namespace: jsii.String("northwind-trade"), Hosted: jsii.Bool(true), App: jsii.String("shop"),
				Stage: jsii.String("lab"), Account: jsii.String("998115851393"), Region: jsii.String("us-east-1"),
			},
			pattern: "longer than 12 characters",
		},
		"namespace starts with ssm": {
			props: &AppTheoryNamingContextProps{
				Namespace: jsii.String("ssmtools"), Hosted: jsii.Bool(true), App: jsii.String("shop"),
				Stage: jsii.String("lab"), Account: jsii.String("998115851393"), Region: jsii.String("us-east-1"),
			},
			pattern: "must not start with aws or ssm",
		},
		"reserved platform namespace": {
			props: &AppTheoryNamingContextProps{
				Namespace: jsii.String("theorycloud"), Hosted: jsii.Bool(true), App: jsii.String("shop"),
				Stage: jsii.String("lab"), Account: jsii.String("998115851393"), Region: jsii.String("us-east-1"),
			},
			pattern: "reserved for first-party platform apps",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, synthErr := synthNamingApp(t, func(stack awscdk.Stack) {
				NewAppTheoryNamingContext(stack, jsii.String("Naming"), tc.props)
			})
			if synthErr == nil {
				t.Fatalf("%s: a broken hosted context must fail synthesis", name)
			}
			if !regexp.MustCompile(tc.pattern).MatchString(synthErr.Error()) {
				t.Fatalf("%s: refusal %q does not name the reason %q", name, synthErr.Error(), tc.pattern)
			}
		})
	}
}
