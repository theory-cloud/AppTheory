package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// v7.0.0 defaulted SecretStringTemplate to "{}" when only GenerateStringKey was
// set and stored {"<key>":"<password>"}. The keyed form with an explicit empty
// template is the unchanged path, so equality with it proves the v7.0.0 value
// byte-for-byte for a fixed seed.
func TestGenerateSecretValueKeyWithoutTemplateKeepsTheV7Value(t *testing.T) {
	keyOnly := generateSecretString{
		GenerateStringKey:  "password",
		PasswordLength:     24,
		ExcludePunctuation: true,
	}
	value, err := generateSecretValue(keyOnly, "Stack/Secret")
	if err != nil {
		t.Fatalf("key without a template must keep the v7.0.0 value: %v", err)
	}
	keyed := keyOnly
	keyed.SecretStringTemplate = "{}"
	keyedValue, err := generateSecretValue(keyed, "Stack/Secret")
	if err != nil {
		t.Fatalf("keyed generation: %v", err)
	}
	if value != keyedValue {
		t.Fatalf("key without a template %q != the keyed empty-template value %q", value, keyedValue)
	}
	if !strings.HasPrefix(value, `{"password":"`) || !strings.HasSuffix(value, `"}`) {
		t.Fatalf("the v7.0.0 shape is {\"<key>\":\"<password>\"}: %q", value)
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(value), &object); err != nil {
		t.Fatalf("the value is not a JSON object: %v (%q)", err, value)
	}
	if len(object) != 1 || len(object["password"]) != 24 {
		t.Fatalf("unexpected generated secret: %+v", object)
	}
}

func TestProvisionSecretsWarnsOnKeyWithoutTemplate(t *testing.T) {
	var mu sync.Mutex
	var created map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		var payload map[string]any
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // protocol fixture
		mu.Lock()
		created = payload
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		name, _ := payload["Name"].(string) //nolint:errcheck // protocol fixture
		writeTestResponse(t, writer, `{"ARN":"arn:aws:secretsmanager:us-east-1:123456789012:secret:`+name+`-abcdef"}`)
	}))
	defer server.Close()

	var output bytes.Buffer
	runner := &Runner{
		options: Options{Stdout: &output},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSecretsManager}}},
		},
		resourceValues: resourceValues{},
		secretValues:   map[string]string{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "KeyOnly", Type: typeSecretsSecret,
		Properties: json.RawMessage(`{"Name":"app/key-only","GenerateSecretString":{` +
			`"GenerateStringKey":"password","PasswordLength":24,"ExcludePunctuation":true}}`),
	}}}
	if err := runner.provisionSecrets(context.Background(), spec); err != nil {
		t.Fatalf("provision key without a template: %v", err)
	}
	value := runner.secretValues[runner.resourceValues["Stack/KeyOnly"].ARN]
	expected, err := generateSecretValue(generateSecretString{
		SecretStringTemplate: "{}",
		GenerateStringKey:    "password",
		PasswordLength:       24,
		ExcludePunctuation:   true,
	}, "Stack/KeyOnly")
	if err != nil {
		t.Fatalf("keyed reference value: %v", err)
	}
	if value != expected {
		t.Fatalf("provisioned value %q != the v7.0.0 keyed value %q", value, expected)
	}
	mu.Lock()
	secretString, _ := created["SecretString"].(string) //nolint:errcheck // protocol fixture
	mu.Unlock()
	if secretString != expected {
		t.Fatalf("CreateSecret received %q, want %q", secretString, expected)
	}
	logs := output.String()
	if count := strings.Count(logs, "warning:"); count != 1 {
		t.Fatalf("want exactly one warning line, got %d: %q", count, logs)
	}
	for _, want := range []string{
		"local Secrets Manager secret KeyOnly",
		`"If you specify this parameter, then you must also specify SecretStringTemplate"`,
		"https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-secretsmanager-secret-generatesecretstring.html",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("the warning does not contain %q: %q", want, logs)
		}
	}
}
