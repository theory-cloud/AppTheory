package localrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testDigest = "sha256:2dc0f1f26731018b369932201d1dac295edd1730d1280f194486ae093ac39798"

func writeProfile(t *testing.T, document map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "examples-local.json")
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func validProfileDocument() map[string]any {
	return map[string]any{
		"version": 1,
		"profile": map[string]any{
			"lambda": map[string]any{
				"images": map[string]any{
					"go": map[string]any{"tag": "public.ecr.aws/lambda/provided:al2023", "digest": testDigest, "pinned": "2026-11-01"},
				},
			},
			"endpoints": map[string]any{
				"dynamodb": map[string]any{
					"container": "dynamodb-local",
					"env":       []any{"AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMODB_ENDPOINT"},
				},
			},
		},
	}
}

func TestLoadProfileReadsTheHarnessDocument(t *testing.T) {
	profile, err := LoadProfile(writeProfile(t, validProfileDocument()))
	if err != nil {
		t.Fatalf("load profile: %v", err)
	}
	image, err := profile.ImageFor("provided.al2023")
	if err != nil {
		t.Fatalf("resolve image: %v", err)
	}
	if image != "public.ecr.aws/lambda/provided:al2023@"+testDigest {
		t.Fatalf("unexpected image: %s", image)
	}
	names := profile.EndpointEnvNames("dynamodb")
	if strings.Join(names, ",") != "AWS_ENDPOINT_URL,AWS_ENDPOINT_URL_DYNAMODB,DYNAMODB_ENDPOINT" {
		t.Fatalf("unexpected endpoint env names: %v", names)
	}
	if names := profile.EndpointEnvNames("sqs"); len(names) != 1 || names[0] != "AWS_ENDPOINT_URL_SQS" {
		t.Fatalf("unexpected default endpoint env names: %v", names)
	}
}

func TestLoadProfileAlsoAcceptsAStandaloneProfile(t *testing.T) {
	document, ok := validProfileDocument()["profile"].(map[string]any)
	if !ok {
		t.Fatal("test profile document has no profile object")
	}
	profile, err := LoadProfile(writeProfile(t, document))
	if err != nil {
		t.Fatalf("load standalone profile: %v", err)
	}
	if _, err := profile.ImageFor("provided.al2023"); err != nil {
		t.Fatalf("standalone profile did not resolve its image: %v", err)
	}
}

func TestProfileRejectsUnpinnedOrMismatchedImages(t *testing.T) {
	cases := map[string]map[string]any{
		"tag only":  {"tag": "public.ecr.aws/lambda/provided:al2023", "digest": ""},
		"wrong tag": {"tag": "public.ecr.aws/lambda/nodejs:24", "digest": testDigest},
	}
	for name, pin := range cases {
		t.Run(name, func(t *testing.T) {
			document := validProfileDocument()
			profileDocument, ok := document["profile"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no profile object")
			}
			lambdaSection, ok := profileDocument["lambda"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no lambda section")
			}
			images, ok := lambdaSection["images"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no image pins")
			}
			images["go"] = pin
			path := writeProfile(t, document)
			profile, err := LoadProfile(path)
			if err != nil {
				t.Fatalf("load profile: %v", err)
			}
			_, imageErr := profile.ImageFor("provided.al2023")
			if imageErr == nil {
				t.Fatalf("%s must fail closed", name)
			}
			if !strings.Contains(imageErr.Error(), path) {
				t.Fatalf("%s error does not name the profile path %s: %v", name, path, imageErr)
			}
		})
	}
}

func TestProfileContainersAndBackendEndpoints(t *testing.T) {
	document := validProfileDocument()
	profileDocument, ok := document["profile"].(map[string]any)
	if !ok {
		t.Fatal("test profile document has no profile object")
	}
	profileDocument["containers"] = map[string]any{
		"moto": map[string]any{
			"image":         "motoserver/moto@" + testDigest,
			"containerPort": 5000,
		},
		"s3proxy": map[string]any{
			"image":         "andrewgaul/s3proxy@" + testDigest,
			"containerPort": 80,
			"environment":   map[string]any{"S3PROXY_AUTHORIZATION": "aws-v2-or-v4"},
		},
	}
	endpointsSection, ok := profileDocument["endpoints"].(map[string]any)
	if !ok {
		t.Fatal("test profile document has no endpoints section")
	}
	endpointsSection["kms"] = map[string]any{
		"container": "moto",
		"env":       []any{"AWS_ENDPOINT_URL_KMS", "KMS_ENDPOINT"},
	}
	path := writeProfile(t, document)
	profile, err := LoadProfile(path)
	if err != nil {
		t.Fatalf("load profile: %v", err)
	}
	pin, err := profile.Container("moto")
	if err != nil {
		t.Fatalf("moto container: %v", err)
	}
	if pin.ContainerPort != 5000 || pin.Image != "motoserver/moto@"+testDigest {
		t.Fatalf("unexpected moto pin: %+v", pin)
	}
	endpoints := profile.EndpointsForContainer("moto")
	if len(endpoints) != 1 || endpoints[0].Service != "kms" || endpoints[0].URL != "http://moto:5000" {
		t.Fatalf("unexpected moto endpoints: %+v", endpoints)
	}
	containersSection, ok := profileDocument["containers"].(map[string]any)
	if !ok {
		t.Fatal("test profile document has no containers section")
	}
	containersSection["s3proxy"] = map[string]any{
		"image":         "andrewgaul/s3proxy:master",
		"containerPort": 80,
	}
	unpinned, err := LoadProfile(writeProfile(t, document))
	if err != nil {
		t.Fatalf("load unpinned profile: %v", err)
	}
	if _, err := unpinned.Container("s3proxy"); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("an unpinned backend image must fail closed: %v", err)
	}
}

func TestBackendContainerMapping(t *testing.T) {
	if got := backendContainer(backendDynamoDB); got != backendDynamoDBName {
		t.Fatalf("dynamodb backend maps to %q, want %q", got, backendDynamoDBName)
	}
	if got := backendContainer("moto"); got != "moto" {
		t.Fatalf("a profile backend keeps its name: %q", got)
	}
}

func TestRuntimeClass(t *testing.T) {
	cases := map[string]string{
		"provided.al2023": imageClassGo,
		"provided.al2":    imageClassGo,
		"nodejs24.x":      imageClassNode,
		"nodejs22.x":      imageClassNode,
		"python3.14":      imageClassPython,
	}
	for runtime, expected := range cases {
		actual, err := RuntimeClass(runtime)
		if err != nil || actual != expected {
			t.Fatalf("RuntimeClass(%q) = %q, %v; want %q", runtime, actual, err, expected)
		}
	}
	if _, err := RuntimeClass("java21"); err == nil {
		t.Fatal("unsupported runtimes must fail")
	}
}

func TestProfileImageForWithoutProfile(t *testing.T) {
	var profile *Profile
	if _, err := profile.ImageFor("nodejs24.x"); err == nil {
		t.Fatal("a missing profile must fail closed")
	}
}

func TestDocumentedMinimalProfileIsValid(t *testing.T) {
	documents := []string{
		filepath.Join("..", "..", "docs", "examples", "local-runner.md"),
		filepath.Join("..", "..", "docs", "reference", "local-runner-configuration.md"),
	}
	for _, document := range documents {
		t.Run(filepath.Base(document), func(t *testing.T) {
			section := documentedSection(t, document, "## Run your own app")
			for _, fragment := range []string{
				"github.com/theory-cloud/apptheory/v7/cmd/apptheory-local@",
				"go install",
				"go run -C",
				"go build -C",
				"--profile",
				"cdk.json",
				"node_modules/.bin/cdk",
				"npm install --save aws-cdk-lib@2.275.0 constructs@10.8.1",
				"npm install --save-dev aws-cdk@2.1147.0",
				"aws-cdk-lib/aws-apigatewayv2-integrations",
				"Malformed JSON fails when the command",
				"after synthesis",
			} {
				if !strings.Contains(section, fragment) {
					t.Fatalf("%s: Run your own app does not mention %q", document, fragment)
				}
			}
			if strings.Contains(section, "validates the profile before it synthesizes") {
				t.Fatalf("%s: Run your own app repeats the old profile-validation order", document)
			}
			if filepath.Base(document) == "local-runner.md" {
				if !strings.Contains(section, "three stages") {
					t.Fatalf("%s: Run your own app does not count the profile-validation stages", document)
				}
				if strings.Contains(section, "two stages") {
					t.Fatalf("%s: Run your own app still says profile validation has two stages", document)
				}
			}

			path := filepath.Join(t.TempDir(), "local-profile.json")
			if err := os.WriteFile(path, []byte(documentedBlock(t, section, "#### `local-profile.json`", "json")), 0o600); err != nil {
				t.Fatal(err)
			}
			profile, err := LoadProfile(path)
			if err != nil {
				t.Fatalf("%s: the documented minimal profile does not load: %v", document, err)
			}
			image, err := profile.ImageFor("nodejs24.x")
			if err != nil || !strings.Contains(image, "@sha256:") {
				t.Fatalf("%s: the documented minimal profile does not pin the Node image: %q %v", document, image, err)
			}
			if _, err := profile.ImageForClass(imageClassPython); err != nil {
				t.Fatalf("%s: the documented minimal profile has no Python preflight image: %v", document, err)
			}
			if _, err := profile.DynamoDBImage(); err == nil {
				t.Fatalf("%s: the minimal profile must not require DynamoDB Local", document)
			}
		})
	}
}

func TestDocumentedMinimalAppIsComplete(t *testing.T) {
	document := filepath.Join("..", "..", "docs", "examples", "local-runner.md")
	section := documentedSection(t, document, "## Run your own app")

	var packageJSON struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal([]byte(documentedBlock(t, section, "#### `package.json`", "json")), &packageJSON); err != nil {
		t.Fatalf("documented package.json is not JSON: %v", err)
	}
	for _, dependency := range []string{"aws-cdk-lib", "constructs"} {
		if packageJSON.Dependencies[dependency] == "" {
			t.Fatalf("documented package.json has no %s dependency", dependency)
		}
	}
	if packageJSON.DevDependencies["aws-cdk"] == "" {
		t.Fatal("documented package.json has no aws-cdk dev dependency")
	}

	var cdkJSON struct {
		App string `json:"app"`
	}
	if err := json.Unmarshal([]byte(documentedBlock(t, section, "#### `cdk.json`", "json")), &cdkJSON); err != nil {
		t.Fatalf("documented cdk.json is not JSON: %v", err)
	}
	if cdkJSON.App != "node bin/app.js" {
		t.Fatalf("documented cdk.json app = %q", cdkJSON.App)
	}

	app := documentedBlock(t, section, "#### `bin/app.js`", "javascript")
	for _, fragment := range []string{
		"HttpApi",
		"HttpLambdaIntegration",
		`Code.fromAsset("handler")`,
		"Runtime.NODEJS_24_X",
	} {
		if !strings.Contains(app, fragment) {
			t.Fatalf("documented bin/app.js does not mention %q", fragment)
		}
	}

	handler := documentedBlock(t, section, "#### `handler/index.js`", "javascript")
	if !strings.Contains(handler, "exports.handler") {
		t.Fatal("documented handler does not export a handler")
	}

	for _, fragment := range []string{
		"go run -C ~/code/AppTheory ./cmd/apptheory-local plan",
		"go run -C ~/code/AppTheory ./cmd/apptheory-local \\\n",
		"--app ~/code/my-local-app",
		"--profile ~/code/my-local-app/local-profile.json",
		"--name-prefix my-local-app",
		"curl -i http://127.0.0.1:18780/hello",
		"serving httpv2",
		"local-run: ready",
		"SIGTERM",
		"not the app URL",
	} {
		if !strings.Contains(section, fragment) {
			t.Fatalf("documented minimal app does not mention %q", fragment)
		}
	}
}

func TestDocumentedShutdownOrderMatchesTheRunner(t *testing.T) {
	document := filepath.Join("..", "..", "docs", "reference", "local-runner-configuration.md")
	raw, err := os.ReadFile(document) //nolint:gosec // checked-in documentation path
	if err != nil {
		t.Fatalf("read %s: %v", document, err)
	}
	text := string(raw)
	for _, fragment := range []string{
		"close the listeners (stop accepting requests)",
		"force-remove every",
		"close any connections still in flight",
		"then remove the network",
	} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("%s: shutdown order does not mention %q", document, fragment)
		}
	}
	if strings.Contains(text, "close the\n  listeners and their in-flight connections, then remove the network") {
		t.Fatalf("%s: shutdown order still closes the listeners after removing containers", document)
	}
}

func documentedSection(t *testing.T, path, heading string) string {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // checked-in documentation path
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	text := string(raw)
	start := strings.Index(text, heading)
	if start < 0 {
		t.Fatalf("%s has no %q section", path, heading)
	}
	rest := text[start+len(heading):]
	if end := strings.Index(rest, "\n## "); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

// documentedBlock returns the body of the first fenced block after heading.
func documentedBlock(t *testing.T, section, heading, language string) string {
	t.Helper()
	marker := "\n" + heading + "\n"
	start := strings.Index(section, marker)
	if start < 0 {
		t.Fatalf("documented section has no %q heading", heading)
	}
	rest := section[start+len(marker):]
	opener := "```" + language + "\n"
	open := strings.Index(rest, opener)
	if open < 0 {
		t.Fatalf("%s has no %s block", heading, language)
	}
	body := rest[open+len(opener):]
	end := strings.Index(body, "\n```")
	if end < 0 {
		t.Fatalf("%s block is not closed", heading)
	}
	return body[:end]
}
