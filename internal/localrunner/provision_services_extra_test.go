package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestResourceValueAttributeCoversProvisionedServices(t *testing.T) {
	value := resourceValue{
		Type:         typeCognitoUserPool,
		Name:         "pool-id",
		ARN:          "pool-arn",
		KeyID:        "key-id",
		URL:          "http://queue",
		StreamARN:    "stream-arn",
		ProviderName: "provider-name",
		ProviderURL:  "provider-url",
		LocalIssuer:  "issuer",
		SSMType:      "SecureString",
		SSMValue:     "value",
		ClientSecret: "client-secret",
	}
	cases := map[string]string{
		"Arn":                "pool-arn",
		"TopicArn":           "pool-arn",
		"Name":               "pool-id",
		"TopicName":          "pool-id",
		"KeyId":              "key-id",
		"QueueUrl":           "http://queue",
		"StreamArn":          "stream-arn",
		"ProviderName":       "provider-name",
		"ProviderURL":        "provider-url",
		"Type":               "SecureString",
		"Value":              "value",
		"ClientSecret":       "client-secret",
		"DomainName":         "pool-id.s3.amazonaws.com",
		"RegionalDomainName": "pool-id.s3.us-east-1.amazonaws.com",
	}
	for attr, want := range cases {
		got, ok := value.attribute(attr)
		if !ok || got != want {
			t.Fatalf("attribute(%q) = %q, %v; want %q", attr, got, ok, want)
		}
	}
	if _, ok := value.attribute("Missing"); ok {
		t.Fatal("an unknown attribute must not resolve")
	}
	empty := resourceValue{}
	if _, ok := empty.attribute("ProviderName"); ok {
		t.Fatal("an empty provider name must not resolve")
	}
}

func TestLocalResourceValueFallbacksAndErrors(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}, resourceValues: resourceValues{}}
	ssm, err := runner.localResourceValue(ResourceSpec{
		Stack: "S", LogicalID: "Param", Type: typeSSMParameter,
		Properties: json.RawMessage(`{"Name":"/app/param","Type":"StringList","Value":"a,b"}`),
	}, runner.resourceValues)
	if err != nil || ssm.Name != "/app/param" || ssm.SSMType != "StringList" || ssm.SSMValue != "a,b" {
		t.Fatalf("SSM fallback: %+v %v", ssm, err)
	}
	if ssm.ARN != "arn:aws:ssm:us-east-1:123456789012:parameter/app/param" {
		t.Fatalf("SSM ARN: %q", ssm.ARN)
	}
	topic, err := runner.localResourceValue(ResourceSpec{
		Stack: "S", LogicalID: "Topic", Type: typeSNSTopic,
		Properties: json.RawMessage(`{"TopicName":"local-topic"}`),
	}, runner.resourceValues)
	if err != nil || topic.Name != "local-topic" || !strings.HasSuffix(topic.ARN, ":local-topic") {
		t.Fatalf("SNS fallback: %+v %v", topic, err)
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Pool", Type: typeCognitoUserPool}, runner.resourceValues); err == nil {
		t.Fatal("a Cognito pool without its backend must fail closed")
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Alias", Type: typeKMSAlias}, runner.resourceValues); err == nil {
		t.Fatal("a KMS alias without its backend must fail closed")
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Key", Type: typeKMSKey}, runner.resourceValues); err == nil {
		t.Fatal("a KMS key without its backend must fail closed")
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Bucket", Type: typeS3Bucket}, runner.resourceValues); err == nil {
		t.Fatal("an S3 bucket without its backend must fail closed")
	}
	if _, err := runner.localResourceValue(ResourceSpec{Stack: "S", LogicalID: "Unknown", Type: "AWS::Unknown::Thing"}, runner.resourceValues); err != nil {
		t.Fatalf("an unknown resource must keep its deterministic name: %v", err)
	}
}

func TestSSMParameterHelpers(t *testing.T) {
	name := ssmParameterName(ResourceSpec{
		Stack: "S", LogicalID: "Param", Type: typeSSMParameter,
		Properties: json.RawMessage(`{"Name":"/explicit"}`),
	})
	if name != "/explicit" {
		t.Fatalf("explicit name: %q", name)
	}
	name = ssmParameterName(ResourceSpec{Stack: "S", LogicalID: "NoName", Type: typeSSMParameter})
	if !strings.HasPrefix(name, "/") {
		t.Fatalf("a generated name must start with /: %q", name)
	}
	kind, value := ssmParameterProperties(ResourceSpec{Properties: json.RawMessage(`{"Value":"x"}`)})
	if kind != "String" || value != "x" {
		t.Fatalf("default type: %q %q", kind, value)
	}
	kind, _ = ssmParameterProperties(ResourceSpec{Properties: json.RawMessage(`{not-json`)})
	if kind != "String" {
		t.Fatalf("invalid properties must fall back to String: %q", kind)
	}
}

func TestDeriveProvisioningSkips(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Policy", Type: typeSecretsResourceRule},
		{Stack: "S", LogicalID: "TopicPolicy", Type: typeSNSTopicPolicy},
		{Stack: "S", LogicalID: "Domain", Type: typeCognitoDomain},
		{Stack: "S", LogicalID: "Other", Type: "AWS::IAM::Role"},
	}}
	deriveProvisioningSkips(spec, []assemblyStack{{Name: "S"}})
	if len(spec.Skipped) != 3 {
		t.Fatalf("unexpected skips: %+v", spec.Skipped)
	}
	reasons := map[string]string{}
	for _, skipped := range spec.Skipped {
		reasons[skipped.LogicalID] = skipped.Reason
	}
	if !strings.Contains(reasons["Policy"], "docs/125 true limit") ||
		!strings.Contains(reasons["TopicPolicy"], "docs/125 true limit") ||
		!strings.Contains(reasons["Domain"], "hosted UI") {
		t.Fatalf("unexpected reasons: %+v", reasons)
	}
}

func TestProvisionAliasesCreatesAliasAndResolvesTarget(t *testing.T) {
	var mu sync.Mutex
	var target string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		var payload map[string]any
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // protocol fixture
		mu.Lock()
		if value, ok := payload["TargetKeyId"].(string); ok {
			target = value
		}
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{}`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: "kms"}}},
		},
		resourceValues: resourceValues{
			"S/Key": {Type: typeKMSKey, Name: "key-id", KeyID: "key-id", ARN: "arn:key"},
		},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Alias", Type: typeKMSAlias,
		Properties: json.RawMessage(`{"AliasName":"alias/local","TargetKeyId":{"Fn::GetAtt":["Key","Arn"]}}`),
	}}}
	if err := runner.provisionAliases(context.Background(), spec); err != nil {
		t.Fatalf("provision aliases: %v", err)
	}
	value := runner.resourceValues["S/Alias"]
	if value.Name != "alias/local" || value.KeyID != "key-id" || value.ARN != "arn:aws:kms:us-east-1:123456789012:alias/local" {
		t.Fatalf("unexpected alias: %+v", value)
	}
	mu.Lock()
	defer mu.Unlock()
	if target != "key-id" {
		t.Fatalf("the alias target was not resolved: %q", target)
	}
	if err := runner.provisionAliases(context.Background(), &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Bad", Type: typeKMSAlias, Properties: json.RawMessage(`{"AliasName":"nope"}`)},
	}}); err == nil {
		t.Fatal("an alias without the alias/ prefix must fail")
	}
	if err := runner.provisionAliases(context.Background(), &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Orphan", Type: typeKMSAlias, Properties: json.RawMessage(`{"AliasName":"alias/orphan"}`)},
	}}); err == nil {
		t.Fatal("an alias with no provisioned target must fail")
	}
}

func TestProvisionSecretsUpdatesAnExistingSecret(t *testing.T) {
	var mu sync.Mutex
	var updated bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		target := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		switch {
		case strings.HasSuffix(target, "CreateSecret"):
			writer.WriteHeader(http.StatusBadRequest)
			writeTestResponse(t, writer, `{"__type":"ResourceExistsException","message":"already exists"}`)
		case strings.HasSuffix(target, "DescribeSecret"):
			writeTestResponse(t, writer, `{"ARN":"arn:secret:existing","Name":"app/existing"}`)
		case strings.HasSuffix(target, "PutSecretValue"):
			mu.Lock()
			updated = true
			mu.Unlock()
			writeTestResponse(t, writer, `{"ARN":"arn:secret:existing"}`)
		default:
			t.Errorf("unexpected target %q", target)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSecretsManager}}},
		},
		resourceValues: resourceValues{},
		secretValues:   map[string]string{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Secret", Type: typeSecretsSecret,
		Properties: json.RawMessage(`{"Name":"app/existing","SecretString":"value"}`),
	}}}
	if err := runner.provisionSecrets(context.Background(), spec); err != nil {
		t.Fatalf("provision secrets: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !updated || runner.resourceValues["S/Secret"].ARN != "arn:secret:existing" {
		t.Fatalf("the existing secret was not updated: %+v", runner.resourceValues)
	}
}

func TestProvisionSecretsRejectsMissingAndIncompleteValues(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{"ARN":"arn:secret:unused"}`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSecretsManager}}},
		},
		resourceValues: resourceValues{},
		secretValues:   map[string]string{},
	}
	for _, props := range []string{
		`{"Name":"app/none"}`,
		`{"Name":"app/bad","GenerateSecretString":{"GenerateStringKey":"k","PasswordLength":8}}`,
		`{"Name":"app/bad","GenerateSecretString":{"SecretStringTemplate":"{\"username\":\"u\"}"}}`,
		`{"Name":"app/bad","GenerateSecretString":{"SecretStringTemplate":"not-json","GenerateStringKey":"k"}}`,
	} {
		if err := runner.provisionSecrets(context.Background(), &Spec{Resources: []ResourceSpec{{
			Stack: "S", LogicalID: "Secret", Type: typeSecretsSecret, Properties: json.RawMessage(props),
		}}}); err == nil {
			t.Fatalf("invalid secret properties must fail: %s", props)
		}
	}
	if _, err := generateSecretValue(generateSecretString{
		PasswordLength: 1, GenerateStringKey: "k", SecretStringTemplate: "{}",
	}, "seed"); err == nil {
		t.Fatal("a length shorter than the required classes must fail")
	}
}

func TestProvisionTopicsRejectsInvalidDeduplication(t *testing.T) {
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: backendSNS}}},
		},
		resourceValues: resourceValues{},
	}
	err := runner.provisionTopics(context.Background(), &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Topic", Type: typeSNSTopic,
		Properties: json.RawMessage(`{"TopicName":"local","ContentBasedDeduplication":true}`),
	}}})
	if err == nil || !strings.Contains(err.Error(), "ContentBasedDeduplication") {
		t.Fatalf("deduplication without FIFO must fail: %v", err)
	}
}

func TestProvisionCognitoErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{"UserPool":{"Id":"us-east-1_pool","Arn":"arn:pool"}}`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendCognito}}},
		},
		resourceValues: resourceValues{},
	}
	err := runner.provisionCognito(context.Background(), &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Client", Type: typeCognitoClient,
		Properties: json.RawMessage(`{"ClientName":"client"}`),
	}}})
	if err == nil || !strings.Contains(err.Error(), "no user pool reference") {
		t.Fatalf("a client without a pool must fail: %v", err)
	}
}

func TestResolveProvisionStringForms(t *testing.T) {
	runner := &Runner{
		options:        Options{Stdout: io.Discard},
		resourceValues: resourceValues{"S/Bucket": {Type: typeS3Bucket, Name: "bucket"}},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket"}`)},
	}}
	for raw, want := range map[string]string{
		`"literal"`:        "literal",
		`{"Ref":"Bucket"}`: "bucket",
		`{"Fn::Join":["-",["a",{"Ref":"Bucket"}]]}`: "a-bucket",
	} {
		got, err := runner.resolveProvisionString(json.RawMessage(raw), "S", spec)
		if err != nil || got != want {
			t.Fatalf("resolve %s = %q, %v; want %q", raw, got, err, want)
		}
	}
	if got, err := runner.resolveProvisionString(nil, "S", spec); err != nil || got != "" {
		t.Fatalf("empty value: %q %v", got, err)
	}
	if _, err := runner.resolveProvisionString(json.RawMessage(`{"Fn::Sub":"x"}`), "S", spec); err == nil {
		t.Fatal("an unsupported expression must fail")
	}
}

func TestCognitoIssuerHandlerErrorPaths(t *testing.T) {
	handler := &cognitoIssuerHandler{
		pools:  map[string]bool{"us-east-1_pool": true},
		region: LocalRegion,
		client: http.DefaultClient,
	}
	for path, status := range map[string]int{
		"/": http.StatusNotFound,
		"/cognito-idp/us-east-1/unknown/.well-known/jwks.json":        http.StatusNotFound,
		"/cognito-idp/eu-west-1/us-east-1_pool/.well-known/jwks.json": http.StatusNotFound,
		"/cognito-idp/us-east-1/us-east-1_pool/.well-known/other":     http.StatusNotFound,
	} {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != status {
			t.Fatalf("%s: status %d, want %d", path, recorder.Code, status)
		}
	}
	jwks := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/cognito-idp/us-east-1/us-east-1_pool/.well-known/jwks.json", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, jwks)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("no backend: status %d", recorder.Code)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	handler.backendURL = bad.URL
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/cognito-idp/us-east-1/us-east-1_pool/.well-known/jwks.json", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("upstream failure: status %d", recorder.Code)
	}
	invalid := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeTestResponse(t, writer, `not-json`)
	}))
	defer invalid.Close()
	handler.backendURL = invalid.URL
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodGet,
		"/cognito-idp/us-east-1/us-east-1_pool/.well-known/jwks.json", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("invalid JWKS: status %d", recorder.Code)
	}
	if err := (&Runner{options: Options{Stdout: io.Discard}, resourceValues: resourceValues{}}).
		startCognitoIssuer(context.Background(), &Spec{}); err != nil {
		t.Fatalf("no pools must start no listener: %v", err)
	}
}

func TestDeriveSNSInlineAndUnsupportedProtocols(t *testing.T) {
	stack := assemblyStack{
		Name: "S",
		Template: template{Resources: map[string]templateResource{
			"Topic": {Type: typeSNSTopic, Properties: json.RawMessage(`{"TopicName":"topic","Subscription":[` +
				`{"Protocol":"sqs","Endpoint":{"Fn::GetAtt":["Queue","Arn"]}},` +
				`{"Protocol":"email","Endpoint":"ops@example.com"}]}`)},
			"Queue": {Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)},
			"Nested": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":{"Ref":"Topic"},"Protocol":"http","Endpoint":{"Ref":"Queue"}}`)},
			"BadTopic": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":"arn:aws:sns:us-east-1:123456789012:external","Protocol":"sqs","Endpoint":{"Fn::GetAtt":["Queue","Arn"]}}`)},
		}},
	}
	spec := &Spec{}
	if err := deriveSNSSubscriptions(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Subscriptions) != 1 {
		t.Fatalf("unexpected subscriptions: %+v", spec.Subscriptions)
	}
	if spec.Subscriptions[0].Queue != "Queue" || spec.Subscriptions[0].LogicalID != "Topic/Subscription0" {
		t.Fatalf("inline subscription: %+v", spec.Subscriptions[0])
	}
	if len(spec.Skipped) != 3 {
		t.Fatalf("unexpected skips: %+v", spec.Skipped)
	}
}

func TestProbeBackendEndpointNativeServices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // protocol fixture
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.Contains(string(body), "Action=ListTopics"):
			writer.Header().Set("content-type", "text/xml")
			writeTestResponse(t, writer, `<ListTopicsResponse><ListTopicsResult><Topics/></ListTopicsResult></ListTopicsResponse>`)
		case strings.Contains(target, "DescribeParameters"):
			writer.Header().Set("content-type", "application/x-amz-json-1.1")
			writeTestResponse(t, writer, `{"Parameters":[]}`)
		case strings.Contains(target, "ListSecrets"):
			writer.Header().Set("content-type", "application/x-amz-json-1.1")
			writeTestResponse(t, writer, `{"SecretList":[]}`)
		case strings.Contains(target, "ListStreams"):
			writer.Header().Set("content-type", "application/x-amz-json-1.1")
			writeTestResponse(t, writer, `{"StreamNames":[]}`)
		case strings.Contains(target, "ListUserPools"):
			writer.Header().Set("content-type", "application/x-amz-json-1.1")
			writeTestResponse(t, writer, `{"UserPools":[]}`)
		default:
			t.Errorf("unexpected target %q", target)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	for _, service := range []string{backendSSM, backendSecretsManager, backendSNS, backendKinesis, backendCognito} {
		if err := probeBackendEndpoint(context.Background(), service, server.URL); err != nil {
			t.Fatalf("probe %s: %v", service, err)
		}
	}
}

func TestProvisioningErrorHelpers(t *testing.T) {
	for _, test := range []struct {
		err  error
		want bool
	}{
		{errString("ResourceExistsException: already exists"), true},
		{errString("AccessDenied"), false},
	} {
		if got := secretAlreadyExists(test.err); got != test.want {
			t.Fatalf("secretAlreadyExists(%q) = %v", test.err, got)
		}
	}
	for _, test := range []struct {
		err  error
		want bool
	}{
		{errString("ResourceInUseException: already exists"), true},
		{errString("AccessDenied"), false},
	} {
		if got := streamAlreadyExists(test.err); got != test.want {
			t.Fatalf("streamAlreadyExists(%q) = %v", test.err, got)
		}
	}
	for _, test := range []struct {
		err  error
		want bool
	}{
		{errString("AlreadyExistsException"), true},
		{errString("AccessDenied"), false},
	} {
		if got := aliasAlreadyExists(test.err); got != test.want {
			t.Fatalf("aliasAlreadyExists(%q) = %v", test.err, got)
		}
	}
	if maxInt(0, 3) != 3 || maxInt(5, 3) != 5 {
		t.Fatal("maxInt")
	}
}

func TestProvisionSSMParametersRejectsInvalidProperties(t *testing.T) {
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: backendSSM}}},
		},
		resourceValues: resourceValues{},
	}
	cases := []string{
		`{not-json`,
		`{"Name":"missing-slash","Value":"x"}`,
		`{"Name":"/app/binary","Type":"Binary","Value":"x"}`,
		`{"Name":"/app/empty"}`,
		`{"Name":"/app/expr","Value":{"Fn::Sub":"x"}}`,
	}
	for _, props := range cases {
		if err := runner.provisionSSMParameters(context.Background(), &Spec{Resources: []ResourceSpec{{
			Stack: "S", LogicalID: "Param", Type: typeSSMParameter, Properties: json.RawMessage(props),
		}}}); err == nil {
			t.Fatalf("invalid SSM properties must fail: %s", props)
		}
	}
	noEndpoint := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {Endpoints: []Endpoint{{Service: backendSSM}}},
		},
		resourceValues: resourceValues{},
	}
	if err := noEndpoint.provisionSSMParameters(context.Background(), &Spec{}); err == nil {
		t.Fatal("an SSM backend without a loopback endpoint must fail")
	}
}

func TestProvisionSSMParametersSendsOptionalProperties(t *testing.T) {
	var mu sync.Mutex
	var input map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		mu.Lock()
		_ = json.Unmarshal(body, &input) //nolint:errcheck // protocol fixture
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{"Version":1}`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSSM}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Param", Type: typeSSMParameter,
		Properties: json.RawMessage(`{"Name":"/app/param","Type":"String","Value":"x",` +
			`"Description":"d","Tier":"Standard","DataType":"text"}`),
	}}}
	if err := runner.provisionSSMParameters(context.Background(), spec); err != nil {
		t.Fatalf("provision SSM: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if input["Description"] != "d" || input["Tier"] != "Standard" || input["DataType"] != "text" {
		t.Fatalf("optional properties were not sent: %+v", input)
	}
}

func TestProvisionStreamsRejectsInvalidProperties(t *testing.T) {
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: backendKinesis}}},
		},
		resourceValues: resourceValues{},
	}
	for _, props := range []string{
		`{not-json`,
		`{"Name":"bad","StreamModeDetails":{"StreamMode":"WEIRD"}}`,
	} {
		if err := runner.provisionStreams(context.Background(), &Spec{Resources: []ResourceSpec{{
			Stack: "S", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(props),
		}}}); err == nil {
			t.Fatalf("invalid stream properties must fail: %s", props)
		}
	}
	noEndpoint := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {Endpoints: []Endpoint{{Service: backendKinesis}}},
		},
		resourceValues: resourceValues{},
	}
	if err := noEndpoint.provisionStreams(context.Background(), &Spec{}); err == nil {
		t.Fatal("a Kinesis backend without a loopback endpoint must fail")
	}
}

func TestSecretLocalNameFallsBackToADeterministicName(t *testing.T) {
	name := secretLocalName(ResourceSpec{Stack: "S", LogicalID: "Generated", Type: typeSecretsSecret})
	if !strings.HasPrefix(name, "local-secret-") {
		t.Fatalf("unexpected secret name: %q", name)
	}
	explicit := secretLocalName(ResourceSpec{
		Stack: "S", LogicalID: "Named", Type: typeSecretsSecret,
		Properties: json.RawMessage(`{"Name":"app/explicit"}`),
	})
	if explicit != "app/explicit" {
		t.Fatalf("explicit secret name: %q", explicit)
	}
}

func TestProvisionTopicsSendsDisplayName(t *testing.T) {
	var mu sync.Mutex
	var body string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		mu.Lock()
		body = string(raw)
		mu.Unlock()
		writer.Header().Set("content-type", "text/xml")
		writeTestResponse(t, writer, `<CreateTopicResponse><CreateTopicResult><TopicArn>arn:topic</TopicArn></CreateTopicResult></CreateTopicResponse>`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSNS}}},
		},
		resourceValues: resourceValues{},
	}
	if err := runner.provisionTopics(context.Background(), &Spec{Resources: []ResourceSpec{{
		Stack: "S", LogicalID: "Topic", Type: typeSNSTopic,
		Properties: json.RawMessage(`{"TopicName":"local-topic","DisplayName":"Local"}`),
	}}}); err != nil {
		t.Fatalf("provision topics: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(body, "DisplayName") || !strings.Contains(body, "Local") {
		t.Fatalf("DisplayName was not sent: %s", body)
	}
}

func TestMotoProvisionersFailClosedWithoutAnEndpoint(t *testing.T) {
	for name, provision := range map[string]func(*Runner) error{
		backendSSM: func(r *Runner) error {
			return r.provisionSSMParameters(context.Background(), &Spec{})
		},
		backendSecretsManager: func(r *Runner) error {
			return r.provisionSecrets(context.Background(), &Spec{})
		},
		backendSNS: func(r *Runner) error {
			return r.provisionTopics(context.Background(), &Spec{})
		},
		backendKinesis: func(r *Runner) error {
			return r.provisionStreams(context.Background(), &Spec{})
		},
		backendCognito: func(r *Runner) error {
			return r.provisionCognito(context.Background(), &Spec{})
		},
		"kms": func(r *Runner) error {
			return r.provisionAliases(context.Background(), &Spec{})
		},
	} {
		runner := &Runner{
			options: Options{Stdout: io.Discard},
			backends: map[string]backendProcess{
				"moto": {Endpoints: []Endpoint{{Service: name}}},
			},
			resourceValues: resourceValues{},
		}
		if err := provision(runner); err == nil {
			t.Fatalf("%s without a host URL must fail", name)
		}
	}
}

func TestProvisionCognitoSendsClientOptions(t *testing.T) {
	var mu sync.Mutex
	clientInput := map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		target := request.Header.Get("X-Amz-Target")
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		if strings.HasSuffix(target, "CreateUserPool") {
			if !strings.Contains(string(body), "AutoVerifiedAttributes") ||
				!strings.Contains(string(body), "UsernameAttributes") {
				t.Errorf("pool options were not sent: %s", body)
			}
			writeTestResponse(t, writer, `{"UserPool":{"Id":"pool"}}`)
			return
		}
		mu.Lock()
		_ = json.Unmarshal(body, &clientInput) //nolint:errcheck // protocol fixture
		mu.Unlock()
		writeTestResponse(t, writer, `{"UserPoolClient":{"ClientId":"client","ClientSecret":"secret"}}`)
	}))
	defer server.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendCognito}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{
			Stack: "S", LogicalID: "Pool", Type: typeCognitoUserPool,
			Properties: json.RawMessage(`{"UserPoolName":"pool","AutoVerifiedAttributes":["email"],` +
				`"UsernameAttributes":["email"]}`),
		},
		{
			Stack: "S", LogicalID: "Client", Type: typeCognitoClient,
			Properties: json.RawMessage(`{"UserPoolId":{"Ref":"Pool"},"ClientName":"client",` +
				`"GenerateSecret":true,"ExplicitAuthFlows":["ALLOW_USER_PASSWORD_AUTH"],` +
				`"AllowedOAuthFlows":["code"],"CallbackURLs":["http://127.0.0.1/cb"],` +
				`"LogoutURLs":["http://127.0.0.1/out"],"SupportedIdentityProviders":["COGNITO"]}`),
		},
	}}
	if err := runner.provisionCognito(context.Background(), spec); err != nil {
		t.Fatalf("provision Cognito: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if clientInput["ClientName"] != "client" || clientInput["GenerateSecret"] != true {
		t.Fatalf("unexpected client request: %+v", clientInput)
	}
	if flows, ok := clientInput["ExplicitAuthFlows"].([]any); !ok || len(flows) != 1 {
		t.Fatalf("explicit auth flows were not sent: %+v", clientInput)
	}
	if runner.resourceValues["S/Client"].ClientSecret != "secret" {
		t.Fatalf("the generated client secret was not recorded: %+v", runner.resourceValues["S/Client"])
	}
}

func TestProvisionedDynamicSecretValueForms(t *testing.T) {
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		secretValues: map[string]string{
			"app":     `{"flag":true,"count":12,"nested":{"x":1},"null":null}`,
			"raw":     `not-json`,
			"missing": `{"other":"x"}`,
		},
	}
	if value, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:app:SecretString:flag::}}"); !ok || value != "true" {
		t.Fatalf("boolean JSON value: %q %v", value, ok)
	}
	if value, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:app:SecretString:count::}}"); !ok || value != "12" {
		t.Fatalf("number JSON value: %q %v", value, ok)
	}
	if _, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:app:SecretString:nested::}}"); ok {
		t.Fatal("an object JSON value must not resolve as a string")
	}
	if _, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:raw:SecretString:key::}}"); ok {
		t.Fatal("a non-JSON secret must not resolve a JSON key")
	}
	if _, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:missing:SecretString:absent::}}"); ok {
		t.Fatal("a missing JSON key must not resolve")
	}
	if _, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:short}}"); ok {
		t.Fatal("a malformed reference must not resolve")
	}
}
