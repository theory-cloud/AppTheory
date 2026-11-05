package localcloudfront

import (
	"encoding/json"
	"fmt"
	"strings"
)

// refKind is the shape of an origin domain expression the reader understands.
type refKind string

const (
	refLiteral     refKind = "literal"
	refS3Bucket    refKind = "s3-bucket"
	refFunctionURL refKind = "function-url"
	refUnresolved  refKind = "unresolved"
)

// originDomain is the resolved form of an Origin.DomainName expression.
type originDomain struct {
	Kind       refKind
	DomainName string
	Bucket     string
	Function   string
	Expression string
}

// resolveOriginDomain understands the domain expressions the shipped
// CloudFront constructs emit. A literal domain, an S3 bucket domain and a
// Lambda Function URL domain keep their identity; anything else is reported as
// unresolved so the distribution is refused rather than routed to a guessed
// domain.
//
//nolint:gocognit,gocyclo // the branches mirror the CloudFormation intrinsic grammar
func resolveOriginDomain(raw json.RawMessage, stack string, index *resourceIndex) (originDomain, error) {
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		if literal == "" {
			return originDomain{Kind: refUnresolved, Expression: "empty DomainName"}, nil
		}
		return originDomain{Kind: refLiteral, DomainName: literal}, nil
	}

	var expression map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expression); err != nil || len(expression) != 1 {
		return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
	}
	for key, value := range expression {
		switch key {
		case valueFnGetAtt:
			id, attr, ok := getAtt(value)
			if !ok {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			resource, found := index.lookup(stack, id)
			if !found {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			switch resource.Type {
			case typeS3Bucket:
				if attr == "RegionalDomainName" || attr == "DomainName" || attr == "WebsiteURL" {
					return originDomain{
						Kind:       refS3Bucket,
						DomainName: index.qualified(stack, id) + ".s3.local",
						Bucket:     index.qualified(stack, id),
					}, nil
				}
			case typeFunctionURL:
				if attr == "FunctionUrl" {
					return originDomain{
						Kind:       refFunctionURL,
						DomainName: index.qualified(stack, id) + ".lambda-url.local",
						Function:   index.qualified(stack, id),
					}, nil
				}
			}
			return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
		case "Fn::Select":
			var parts []json.RawMessage
			if err := json.Unmarshal(value, &parts); err != nil || len(parts) != 2 {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			var indexValue int
			if err := json.Unmarshal(parts[0], &indexValue); err != nil || indexValue != 2 {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			var split map[string]json.RawMessage
			if err := json.Unmarshal(parts[1], &split); err != nil || len(split) != 1 {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			rawSplit, ok := split["Fn::Split"]
			if !ok {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			var splitParts []json.RawMessage
			if err := json.Unmarshal(rawSplit, &splitParts); err != nil || len(splitParts) != 2 {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			var separator string
			if err := json.Unmarshal(splitParts[0], &separator); err != nil || separator != "/" {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			id, attr, ok := getAttFromExpression(splitParts[1])
			if !ok || attr != "FunctionUrl" {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			resource, found := index.lookup(stack, id)
			if !found || resource.Type != typeFunctionURL {
				return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
			}
			return originDomain{
				Kind:       refFunctionURL,
				DomainName: index.qualified(stack, id) + ".lambda-url.local",
				Function:   index.qualified(stack, id),
			}, nil
		default:
			// Ref, Fn::Join, Fn::Sub, Fn::If and every other intrinsic are
			// reported rather than guessed.
			return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
		}
	}
	return originDomain{Kind: refUnresolved, Expression: compactJSON(raw)}, nil
}

// getAtt decodes Fn::GetAtt in both its list and dotted-string forms.
func getAtt(raw json.RawMessage) (id, attr string, ok bool) {
	var parts []json.RawMessage
	if err := json.Unmarshal(raw, &parts); err == nil {
		if len(parts) != 2 {
			return "", "", false
		}
		if err := json.Unmarshal(parts[0], &id); err != nil {
			return "", "", false
		}
		if err := json.Unmarshal(parts[1], &attr); err != nil {
			return "", "", false
		}
		return id, attr, id != ""
	}
	var dotted string
	if err := json.Unmarshal(raw, &dotted); err == nil {
		before, after, found := strings.Cut(dotted, ".")
		if !found || before == "" {
			return "", "", false
		}
		return before, after, true
	}
	return "", "", false
}

// getAttFromExpression decodes either a bare Fn::GetAtt value or an object
// whose Fn::GetAtt field holds it.
func getAttFromExpression(raw json.RawMessage) (id, attr string, ok bool) {
	var expression map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expression); err == nil {
		if nested, found := expression[valueFnGetAtt]; found {
			return getAtt(nested)
		}
	}
	return getAtt(raw)
}

// resolveResourceRef resolves a Ref or Fn::GetAtt to a qualified logical id.
func resolveResourceRef(raw json.RawMessage, stack string, index *resourceIndex) (string, bool) {
	var expression map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expression); err != nil || len(expression) != 1 {
		return "", false
	}
	for key, value := range expression {
		switch key {
		case "Ref":
			var id string
			if err := json.Unmarshal(value, &id); err != nil || id == "" {
				return "", false
			}
			if _, ok := index.lookup(stack, id); !ok {
				return "", false
			}
			return index.qualified(stack, id), true
		case valueFnGetAtt:
			id, _, ok := getAtt(value)
			if !ok {
				return "", false
			}
			if _, found := index.lookup(stack, id); !found {
				return "", false
			}
			return index.qualified(stack, id), true
		}
	}
	return "", false
}

// resolvePolicyRef resolves a behavior policy id. A Ref names a policy in the
// assembly; a literal string is a managed policy id and must be in the pinned
// table.
func resolvePolicyRef(
	raw json.RawMessage,
	kind PolicyKind,
	stack string,
	index *resourceIndex,
) (*Policy, string) {
	if len(raw) == 0 {
		return nil, ""
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		if literal == "" {
			return nil, ""
		}
		policy, ok := managedPolicy(literal, kind)
		if !ok {
			return nil, fmt.Sprintf("managed %s %q is not in the pinned policy table", kind, literal)
		}
		return policy, ""
	}
	id, ok := resolveResourceRef(raw, stack, index)
	if !ok {
		return nil, fmt.Sprintf("%s expression %s is not a policy reference the local gateway understands", kind, compactJSON(raw))
	}
	return &Policy{Kind: kind, LogicalID: id, ID: id}, ""
}

// resolveFunctionRef resolves a FunctionAssociations FunctionARN to a
// qualified CloudFront Function logical id.
func resolveFunctionRef(raw json.RawMessage, stack string, index *resourceIndex) (string, bool) {
	var expression map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expression); err != nil || len(expression) != 1 {
		return "", false
	}
	value, ok := expression[valueFnGetAtt]
	if !ok {
		return "", false
	}
	id, attr, ok := getAtt(value)
	if !ok || attr != "FunctionARN" {
		return "", false
	}
	resource, found := index.lookup(stack, id)
	if !found || resource.Type != typeCloudFrontFunction {
		return "", false
	}
	return index.qualified(stack, id), true
}

func compactJSON(raw json.RawMessage) string {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return string(raw)
	}
	return string(encoded)
}
