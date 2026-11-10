package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

// LOCAL-W3-M1 validation, fourth pass: the remaining enumerated statement
// elements and the IAM role/policy derivation the narrow IAM path reads.

func TestShapeStatementScopeBranches(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		trust  bool
		want   string
		absent bool
	}{
		{"NotResource", `{"Effect":"Allow","Action":"execute-api:Invoke","NotResource":"x"}`, false, "NotResource", false},
		{"action not a string", `{"Effect":"Allow","Action":7,"Resource":"x"}`, false, "neither a string nor a list", false},
		{"resource not a string", `{"Effect":"Allow","Action":"execute-api:Invoke","Resource":7}`, false, "neither a string nor a list", false},
		{"trust without resource", `{"Effect":"Allow","Action":"sts:AssumeRole"}`, true, "", false},
		{"trust principal is a string", `{"Effect":"Allow","Action":"sts:AssumeRole","Principal":"arn:aws:iam::1:role/caller"}`, true, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var statement iamPolicyStatement
			if err := json.Unmarshal([]byte(tc.raw), &statement); err != nil {
				t.Fatalf("decode: %v", err)
			}
			_, err := shapeStatementScope(statement, tc.trust, false)
			if tc.want == "" {
				if err != nil && !strings.Contains(err.Error(), tc.want) {
					// A case that must succeed has no error at all.
					if !strings.Contains(err.Error(), "irrelevant") {
						t.Fatalf("unexpected error: %v", err)
					}
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestShapePrincipalsAndConditions(t *testing.T) {
	principalCases := []struct {
		raw  string
		want string
	}{
		{`"*"`, "wildcard Principal"},
		{`{"AWS":"arn:aws:iam::1:role/team-*"}`, "uses a wildcard"},
		{`{"AWS":"a-role"}`, "is outside the local IAM subset"},
		{`{"AWS":["arn:aws:iam::1:root","arn:aws:iam::1:role/caller"]}`, ""},
		{`{"Service":"lambda.amazonaws.com"}`, "is outside the local IAM subset"},
		{`[]`, ""},
	}
	for _, tc := range principalCases {
		arnes, roots, named, err := shapePrincipals(json.RawMessage(tc.raw), false)
		if tc.want == "" {
			if err != nil {
				t.Fatalf("%s: %v", tc.raw, err)
			}
			if !named {
				t.Fatalf("%s must report a prompt principal", tc.raw)
			}
			if len(arnes)+len(roots) == 0 && tc.raw != `[]` {
				t.Fatalf("%s resolved no principal: %v %v", tc.raw, arnes, roots)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s = %v, want %q", tc.raw, err, tc.want)
		}
	}
	if _, _, named, err := shapePrincipals(nil, true); err != nil || !named {
		t.Fatalf("an absent Principal is named and valid for an identity policy: %v", err)
	}
	if _, _, _, err := shapePrincipals(json.RawMessage(`not json`), true); err == nil {
		t.Fatal("a Principal that is not JSON must fail")
	}

	conditionCases := []struct {
		raw  string
		want string
	}{
		{`{"Bool":{"aws:SecureTransport":"true"}}`, "Condition operator"},
		{`{"StringEquals":{"aws:SourceVpc":"vpc-1"}}`, "Condition key"},
		{`{"StringEquals":{"aws:PrincipalArn":7}}`, "not a string or a list"},
		{`{"StringEquals":{"aws:PrincipalArn":["a",7]}}`, "not a string"},
		{`{"StringEquals":{"aws:PrincipalArn":"arn:aws:iam::1:role/*"}}`, "uses a wildcard"},
		{`{}`, ""},
		{`"not json"`, "fails closed"},
	}
	for _, tc := range conditionCases {
		values, err := shapeConditions(json.RawMessage(tc.raw), "")
		if tc.want == "" {
			if err != nil || len(values) != 0 {
				t.Fatalf("%s = %v %v", tc.raw, values, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s = %v, want %q", tc.raw, err, tc.want)
		}
	}
	if values, err := shapeConditions(json.RawMessage(`{"StringEquals":{"lambda:FunctionUrlAuthType":"AWS_IAM"}}`), iamFunctionURLTypeKey); err != nil || len(values) != 0 {
		t.Fatalf("the Function URL key is checked separately: %v %v", values, err)
	}
}

func TestApplicabilityRefusals(t *testing.T) {
	cases := []struct {
		raw   string
		trust bool
		want  string
	}{
		{`{"Effect":"Allow","Action":"sts:AssumeRole"}`, true, "no Principal"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Resource":"x","Principal":{"AWS":"arn:aws:iam::1:role/caller"}}`, false, "none"},
		{`{"Effect":"Allow","Action":"lambda:InvokeFunctionUrl","Resource":"arn:aws:lambda:us-east-1:1:function:f",` +
			`"Principal":{"AWS":"arn:aws:iam::1:root"},"Condition":{"StringEquals":{"lambda:FunctionUrlAuthType":7}}}`, false, "must be a string"},
	}
	for _, tc := range cases {
		var statement iamPolicyStatement
		if err := json.Unmarshal([]byte(tc.raw), &statement); err != nil {
			t.Fatalf("decode: %v", err)
		}
		scope, scopeErr := shapeStatementScope(statement, tc.trust, strings.Contains(tc.raw, "lambda:InvokeFunctionUrl"))
		if scopeErr != nil {
			// The scope is expected to pass for these cases.
			t.Fatalf("scope: %v", scopeErr)
		}
		_, err := applicability(statement, scope)
		if tc.want == "none" {
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("error = %v, want %q", err, tc.want)
		}
	}
}

func TestDeriveIAMRolesAttachesPoliciesAndReportsBadRoles(t *testing.T) {
	resources := map[string]any{
		"GoodRole": map[string]any{"Type": typeIAMRole, "Properties": map[string]any{
			"RoleName":                 "good",
			"AssumeRolePolicyDocument": map[string]any{"Statement": []any{}},
			"Policies": []any{map[string]any{
				"PolicyDocument": map[string]any{"Statement": []any{}},
			}},
		}},
		"OtherRole": map[string]any{"Type": typeIAMRole, "Properties": map[string]any{
			"RoleName": "other",
		}},
		"BadRole": map[string]any{"Type": typeIAMRole, "Properties": "not-an-object"},
		"Policy": map[string]any{"Type": typeIAMPolicy, "Properties": map[string]any{
			"PolicyDocument": map[string]any{"Statement": []any{}},
			"Roles":          []any{map[string]any{"Ref": "GoodRole"}, "literal", map[string]any{"Ref": "Missing"}},
		}},
		"Managed": map[string]any{"Type": typeIAMManagedPolicy, "Properties": map[string]any{
			"PolicyDocument": map[string]any{"Statement": []any{}},
			"Roles":          []any{map[string]any{"Ref": "OtherRole"}},
		}},
		"EmptyPolicy": map[string]any{"Type": typeIAMPolicy, "Properties": map[string]any{
			"Roles": []any{map[string]any{"Ref": "GoodRole"}},
		}},
		"BadPolicy": map[string]any{"Type": typeIAMPolicy, "Properties": "not-an-object"},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.IAMRoles) != 2 {
		t.Fatalf("the two valid roles must be derived: %+v", spec.IAMRoles)
	}
	byName := map[string]iamRoleSpec{}
	for _, role := range spec.IAMRoles {
		byName[role.Name] = role
	}
	if len(byName["good"].Identity) != 2 {
		t.Fatalf("the role must carry its inline and attached policy: %+v", byName["good"].Identity)
	}
	if len(byName["other"].Identity) != 1 {
		t.Fatalf("the managed policy must attach: %+v", byName["other"].Identity)
	}
	found := false
	for _, skipped := range spec.Skipped {
		if skipped.LogicalID == "BadRole" && strings.Contains(skipped.Reason, "not a JSON object") {
			found = true
		}
	}
	if !found {
		t.Fatalf("a role whose properties are not an object must be reported: %+v", spec.Skipped)
	}
}
