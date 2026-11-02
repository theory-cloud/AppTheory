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
			profile, err := LoadProfile(writeProfile(t, document))
			if err != nil {
				t.Fatalf("load profile: %v", err)
			}
			if _, err := profile.ImageFor("provided.al2023"); err == nil {
				t.Fatalf("%s must fail closed", name)
			}
		})
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
				"github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@",
				"go install",
				"go run -C",
				"go build -C",
				"--profile",
				"cdk.json",
				"node_modules/.bin/cdk",
			} {
				if !strings.Contains(section, fragment) {
					t.Fatalf("%s: Run your own app does not mention %q", document, fragment)
				}
			}

			path := filepath.Join(t.TempDir(), "local-profile.json")
			if err := os.WriteFile(path, []byte(documentedJSONBlock(t, section)), 0o600); err != nil {
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

func documentedJSONBlock(t *testing.T, section string) string {
	t.Helper()
	const marker = "```json\n"
	start := strings.Index(section, marker)
	if start < 0 {
		t.Fatal("documented section has no JSON block")
	}
	rest := section[start+len(marker):]
	end := strings.Index(rest, "\n```")
	if end < 0 {
		t.Fatal("documented JSON block is not closed")
	}
	return rest[:end]
}
