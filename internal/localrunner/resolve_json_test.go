package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

// jsonSpec builds the smallest assembly a document resolver needs: one stack,
// one account, a parameter, a condition and a mapping.
func jsonSpec() *Spec {
	return &Spec{
		Templates: map[string]templateContext{
			"Stack": {
				Parameters: map[string]templateParameter{
					"Stage": {Type: "String", Default: json.RawMessage(`"lab"`)},
				},
				Conditions: map[string]json.RawMessage{
					"IsLab": json.RawMessage(`{"Fn::Equals":[{"Ref":"Stage"},"lab"]}`),
				},
				Mappings: map[string]map[string]map[string]any{
					"RegionMap": {"us-east-1": {"Name": "use1"}},
				},
			},
		},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Api", Type: typeRESTAPI, Properties: json.RawMessage(`{}`)},
			{Stack: "Stack", LogicalID: "Role", Type: typeIAMRole, Properties: json.RawMessage(`{"RoleName":"vending-caller"}`)},
			{Stack: "Stack", LogicalID: "Worker", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"worker"}`)},
			{Stack: "Stack", LogicalID: "Version", Type: "AWS::Lambda::Version", Properties: json.RawMessage(`{"FunctionName":{"Ref":"Worker"}}`)},
			{Stack: "Stack", LogicalID: "Trigger", Type: "Custom::Trigger", Properties: json.RawMessage(`{}`)},
		},
		accounts: map[string]string{"Stack": "787107040121"},
		regions:  map[string]string{"Stack": "us-east-1"},
	}
}

func resolveDocument(t *testing.T, runner *Runner, spec *Spec, document string) any {
	t.Helper()
	var raw any
	if err := json.Unmarshal([]byte(document), &raw); err != nil {
		t.Fatalf("decode %s: %v", document, err)
	}
	resolved, err := runner.resolveJSONValue(spec, "Stack", raw)
	if err != nil {
		t.Fatalf("resolve %s: %v", document, err)
	}
	return resolved
}

func TestResolveJSONValueResolvesTheDocumentedIntrinsics(t *testing.T) {
	runner := &Runner{spec: jsonSpec()}
	spec := jsonSpec()
	cases := []struct{ document, want string }{
		{`{"Ref":"AWS::Partition"}`, LocalPartition},
		{`{"Ref":"AWS::Region"}`, "us-east-1"},
		{`{"Ref":"AWS::AccountId"}`, "787107040121"},
		{`{"Ref":"AWS::StackName"}`, "Stack"},
		{`{"Ref":"AWS::URLSuffix"}`, "amazonaws.com"},
		{`{"Ref":"Stage"}`, "lab"},
		{`{"Ref":"Api"}`, localPhysicalID("api", "Api")},
		{`{"Ref":"Role"}`, "arn:aws:iam::787107040121:role/vending-caller"},
		{`{"Ref":"Worker"}`, "arn:aws:lambda:us-east-1:787107040121:function:worker"},
		{`{"Fn::GetAtt":["Role","Arn"]}`, "arn:aws:iam::787107040121:role/vending-caller"},
		{`{"Fn::Join":["",["arn:aws:execute-api:us-east-1:","787107040121",":",{"Ref":"Api"},"/lab/GET/x"]]}`,
			"arn:aws:execute-api:us-east-1:787107040121:" + localPhysicalID("api", "Api") + "/lab/GET/x"},
		{`{"Fn::Select":[1,{"Fn::Split":["/","a/b/c"]}]}`, "b"},
		{`{"Fn::If":["IsLab","yes","no"]}`, "yes"},
		{`{"Fn::FindInMap":["RegionMap",{"Ref":"AWS::Region"},"Name"]}`, "use1"},
		{`{"Fn::Sub":"${Stage}-suffix"}`, "lab-suffix"},
		{`{"Fn::Sub":["${Stage}-${!Literal}-${Role}",{}]}`, "lab-Literal-arn:aws:iam::787107040121:role/vending-caller"},
	}
	for _, tc := range cases {
		resolved := resolveDocument(t, runner, spec, tc.document)
		text, ok := resolved.(string)
		if !ok || text != tc.want {
			t.Fatalf("%s resolved to %#v, want %q", tc.document, resolved, tc.want)
		}
	}
}

func TestResolveJSONValueKeepsDocumentShapes(t *testing.T) {
	runner := &Runner{spec: jsonSpec()}
	spec := jsonSpec()
	resolved := resolveDocument(t, runner, spec, `{
		"String":{"Ref":"Stage"},
		"Number":42,
		"Flag":true,
		"List":[{"Ref":"Stage"},"fixed"],
		"Nested":{"Deep":{"Ref":"AWS::AccountId"}}
	}`)
	object, ok := resolved.(map[string]any)
	if !ok {
		t.Fatalf("the document must stay an object: %T", resolved)
	}
	if object["String"] != "lab" || object["Number"] != float64(42) || object["Flag"] != true {
		t.Fatalf("unexpected scalars: %#v", object)
	}
	list, ok := object["List"].([]any)
	if !ok || len(list) != 2 || list[0] != "lab" || list[1] != "fixed" {
		t.Fatalf("unexpected list: %#v", object["List"])
	}
	nested, ok := object["Nested"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected nested value: %#v", object["Nested"])
	}
	if nested["Deep"] != "787107040121" {
		t.Fatalf("a nested expression must resolve in place: %#v", nested)
	}
}

func TestResolveJSONValueFailsClosedByName(t *testing.T) {
	runner := &Runner{spec: jsonSpec()}
	spec := jsonSpec()
	for _, tc := range []struct{ document, want string }{
		{`{"Fn::ImportValue":"Exported"}`, "Fn::ImportValue names a deployed stack's export"},
		{`{"Ref":"Missing"}`, "a Ref to Missing names no parameter or resource"},
		{`{"Fn::GetAtt":["Trigger","Data"]}`, "reads a custom resource's Data"},
		{`{"Fn::GetAtt":["Missing","Arn"]}`, "names no resource"},
		{`{"Fn::Select":[5,["a"]]}`, "outside a list"},
		{`{"Fn::Split":["",  "x"]}`, "delimiter must be a non-empty string"},
	} {
		var raw any
		if err := json.Unmarshal([]byte(tc.document), &raw); err != nil {
			t.Fatalf("decode: %v", err)
		}
		_, err := runner.resolveJSONValue(spec, "Stack", raw)
		if err == nil {
			t.Fatalf("%s must fail closed", tc.document)
		}
		if tc.want != "" && !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s error %q does not name the cause %q", tc.document, err, tc.want)
		}
	}
}

func TestResolveJSONGetAttReadsACustomResourcesData(t *testing.T) {
	runner := &Runner{spec: jsonSpec()}
	spec := jsonSpec()
	runner.recordCustomResourceData(
		CustomResourceSpec{LogicalID: "Trigger", Stack: "Stack"},
		customResourceResponse{
			Status:             customResourceStatusSuccess,
			PhysicalResourceID: "physical",
			Data:               map[string]any{"Generated": "value", "Count": float64(2)},
		})
	resolved := resolveDocument(t, runner, spec, `{"Fn::GetAtt":["Trigger","Generated"]}`)
	if resolved != "value" {
		t.Fatalf("a Data attribute must resolve: %#v", resolved)
	}
	count := resolveDocument(t, runner, spec, `{"Fn::GetAtt":["Trigger","Count"]}`)
	if count != "2" {
		t.Fatalf("a numeric Data attribute must resolve as text: %#v", count)
	}
	if physical := runner.customResourcePhysicalIDs["Stack/Trigger"]; physical != "physical" {
		t.Fatalf("the physical id must be recorded: %q", physical)
	}
	if _, ok := runner.customResourceAttribute("Stack", "Trigger", "Missing"); ok {
		t.Fatal("an absent attribute must not resolve")
	}
	var raw any
	if err := json.Unmarshal([]byte(`{"Fn::GetAtt":["Trigger","Missing"]}`), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, err := runner.resolveJSONValue(spec, "Stack", raw); err == nil ||
		!strings.Contains(err.Error(), "names no Data attribute") {
		t.Fatalf("an absent Data attribute must fail closed by name: %v", err)
	}
}

func TestStackAccountFallsBackToTheLocalIdentity(t *testing.T) {
	runner := &Runner{}
	if got := runner.stackAccount(&Spec{}, "Stack"); got != LocalAccountID {
		t.Fatalf("an unresolved environment must use the local account: %q", got)
	}
	if got := runner.stackAccount(jsonSpec(), "Stack"); got != "787107040121" {
		t.Fatalf("a resolved environment must use its account: %q", got)
	}
	if got := stackRegion(jsonSpec(), "Other"); got != LocalRegion {
		t.Fatalf("an unresolved region must use the local region: %q", got)
	}
}
