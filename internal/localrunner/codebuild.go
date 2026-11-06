package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// AWS CodeBuild through AWS's published local agent.
//
// A synthesized AWS::CodeBuild::Project is served on the run's CodeBuild control
// endpoint. StartBuild runs the project's buildspec through the digest-pinned
// local agent image, and the build's state transitions are published as
// "CodeBuild Build State Change" events on the run's EventBridge bus, so the
// app's state-change rule delivers them.
//
// https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html
// https://docs.aws.amazon.com/codebuild/latest/APIReference/API_StartBuild.html
// https://docs.aws.amazon.com/codebuild/latest/APIReference/API_BatchGetBuilds.html

type codeBuildProjectProperties struct {
	Name        string `json:"Name"`
	Description string `json:"Description"`
	Environment struct {
		Type                 string `json:"Type"`
		Image                string `json:"Image"`
		ComputeType          string `json:"ComputeType"`
		PrivilegedMode       bool   `json:"PrivilegedMode"`
		EnvironmentVariables []struct {
			Name string `json:"Name"`
			// Value is a String in the schema, but CloudFormation accepts an
			// intrinsic function wherever a string is expected, so the raw
			// form is kept until it is resolved.
			// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-codebuild-project-environmentvariable.html
			Value json.RawMessage `json:"Value"`
			Type  string          `json:"Type"`
		} `json:"EnvironmentVariables"`
	} `json:"Environment"`
	Source struct {
		Type      string          `json:"Type"`
		BuildSpec json.RawMessage `json:"BuildSpec"`
	} `json:"Source"`
	Artifacts struct {
		Type string `json:"Type"`
	} `json:"Artifacts"`
	Cache struct {
		Type string `json:"Type"`
	} `json:"Cache"`
	TimeoutInMinutes    int               `json:"TimeoutInMinutes"`
	VpcConfig           json.RawMessage   `json:"VpcConfig"`
	SecondarySources    []json.RawMessage `json:"SecondarySources"`
	FileSystemLocations []json.RawMessage `json:"FileSystemLocations"`
	ReportGroups        []json.RawMessage `json:"ReportGroups"`
}

// deriveCodeBuildProjects reads every CodeBuild project. A feature the local
// agent does not reproduce is named on the project spec; it is never silently
// dropped.
func deriveCodeBuildProjects(spec *Spec, stacks []assemblyStack, stack assemblyStack) error {
	context := templateContext{
		Parameters: stack.Template.Parameters,
		Conditions: stack.Template.Conditions,
		Mappings:   stack.Template.Mappings,
	}
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeCodeBuildProject {
			continue
		}
		var props codeBuildProjectProperties
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return fmt.Errorf("%s/%s: parse CodeBuild project properties: %w", stack.Name, id, err)
		}
		logicalID := qualify(stacks, stack.Name, id)
		name, err := resourceName(ResourceSpec{
			Stack:      stack.Name,
			LogicalID:  id,
			Type:       resource.Type,
			Properties: resource.Properties,
		})
		if err != nil {
			return err
		}
		project := CodeBuildProjectSpec{
			LogicalID:            logicalID,
			Stack:                stack.Name,
			Name:                 name,
			Image:                strings.TrimSpace(props.Environment.Image),
			SourceType:           strings.TrimSpace(props.Source.Type),
			EnvironmentVariables: map[string]string{},
			Privileged:           props.Environment.PrivilegedMode,
			TimeoutMinutes:       props.TimeoutInMinutes,
		}
		if project.TimeoutMinutes <= 0 {
			project.TimeoutMinutes = 60
		}
		if project.Image == "" {
			project.Deviations = append(project.Deviations, "the project declares no Environment.Image; the profile cannot map it")
		}
		if len(props.Source.BuildSpec) > 0 {
			if inline, decodeErr := decodeString(props.Source.BuildSpec); decodeErr == nil {
				project.BuildSpec = inline
			} else if resolved, resolveErr := context.resolve(rawValue(props.Source.BuildSpec)); resolveErr == nil {
				if text, ok := templateString(resolved); ok {
					project.BuildSpec = text
				}
			} else {
				project.Deviations = append(project.Deviations, "the buildspec is a CloudFormation expression that cannot be resolved before deployment")
			}
		}
		// BuildSpec.fromSourceFilename stores a path string; the same decode
		// path drops it into BuildSpec, so distinguish a path-looking value.
		if looksLikeBuildSpecPath(project.BuildSpec) {
			project.BuildSpecPath = project.BuildSpec
			project.BuildSpec = ""
		}
		for _, variable := range props.Environment.EnvironmentVariables {
			if strings.TrimSpace(variable.Name) == "" {
				continue
			}
			value, deviation := codeBuildEnvironmentValue(variable.Value, stack, context)
			if deviation != "" {
				project.Deviations = append(project.Deviations,
					"environment variable "+variable.Name+" "+deviation)
				continue
			}
			project.EnvironmentVariables[variable.Name] = value
		}
		if project.SourceType != "" && project.SourceType != "NO_SOURCE" {
			project.Deviations = append(project.Deviations,
				"the source type "+project.SourceType+" is not fetched locally; only NO_SOURCE buildspecs run")
		}
		if props.Environment.PrivilegedMode {
			project.Deviations = append(project.Deviations,
				"privileged mode is reported, not enabled; the local agent starts the build container unprivileged")
		}
		if len(props.VpcConfig) > 0 && string(props.VpcConfig) != jsonNull {
			project.Deviations = append(project.Deviations,
				"no VPC: the build container runs on the agent's own Docker network")
		}
		if props.Cache.Type != "" && props.Cache.Type != "NO_CACHE" {
			project.Deviations = append(project.Deviations, "no cache")
		}
		if props.Artifacts.Type != "" && props.Artifacts.Type != "NO_ARTIFACTS" {
			project.Deviations = append(project.Deviations, "no artifact upload; the agent writes to the run's artifact directory")
		}
		if len(props.SecondarySources) > 0 {
			project.Deviations = append(project.Deviations, "secondary sources are not served")
		}
		if len(props.FileSystemLocations) > 0 {
			project.Deviations = append(project.Deviations, "EFS file-system locations are not mounted")
		}
		if len(props.ReportGroups) > 0 {
			project.Deviations = append(project.Deviations, "no report groups")
		}
		if len(project.Deviations) > 0 {
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeCodeBuildProject,
				Reason:    strings.Join(project.Deviations, "; "),
			})
		}
		spec.CodeBuildProjects = append(spec.CodeBuildProjects, project)
	}
	return nil
}

func rawValue(raw json.RawMessage) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return value
}

// codeBuildEnvironmentValue resolves one EnvironmentVariables Value. The schema
// types Value as a String, so a literal resolves directly; a CloudFormation
// expression resolves through the shared template resolver, and a Ref or
// Fn::GetAtt that names a resource in the same stack resolves to the
// deterministic local value the runner derives from the template. Anything that
// still depends on the deployed stack (or on a backend this plan did not start)
// returns a deviation naming the expression instead of failing the plan.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-codebuild-project-environmentvariable.html
func codeBuildEnvironmentValue(raw json.RawMessage, stack assemblyStack, context templateContext) (string, string) {
	if len(raw) == 0 || string(raw) == jsonNull {
		return "", ""
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		return literal, ""
	}
	value := rawValue(raw)
	if value == nil {
		return "", "is not valid JSON"
	}
	resolved, err := context.resolve(value)
	if err == nil {
		if text, ok := templateString(resolved); ok {
			return text, ""
		}
		return "", "is a CloudFormation expression that does not resolve to a string"
	}
	var unresolved *unresolvedTemplateError
	if !asUnresolved(err, &unresolved) {
		return "", "is a CloudFormation expression that failed to resolve (" + err.Error() + ")"
	}
	if local, ok := codeBuildLocalReference(value, stack); ok {
		return local, ""
	}
	return "", "is a CloudFormation expression that cannot be resolved before deployment (" +
		unresolved.Name + "); the local agent receives the project without it"
}

// codeBuildLocalReference resolves a single-intrinsic Ref or Fn::GetAtt that
// names a resource in the same stack to the deterministic local value the runner
// derives from the template. Types whose local value needs a started backend
// stay unresolved.
func codeBuildLocalReference(value any, stack assemblyStack) (string, bool) {
	intrinsic, ok := value.(map[string]any)
	if !ok || len(intrinsic) != 1 {
		return "", false
	}
	id, attr := "", ""
	if ref, ok := intrinsic["Ref"].(string); ok {
		id = ref
	} else if getAtt, ok := intrinsic["Fn::GetAtt"]; ok {
		parsedID, parsedAttr, err := parseGetAtt(getAtt)
		if err != nil {
			return "", false
		}
		id, attr = parsedID, parsedAttr
	} else {
		return "", false
	}
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return "", false
	}
	spec := ResourceSpec{
		Stack:      stack.Name,
		LogicalID:  id,
		Type:       resource.Type,
		Properties: resource.Properties,
	}
	// A bucket's Ref is the physical name provisioning creates, and the plan
	// already prints that same name, so it resolves even though no s3proxy is
	// running yet. localResourceValue refuses it because a function's
	// environment must not name a bucket that does not exist.
	if resource.Type == typeS3Bucket && attr == "" {
		name, err := resourceName(spec)
		if err != nil || name == "" {
			return "", false
		}
		return name, true
	}
	local, err := localResourceValueFor(spec, nil, nil)
	if err != nil {
		return "", false
	}
	if attr == "" {
		resolved, err := refString(spec, local)
		if err != nil || resolved == "" {
			return "", false
		}
		return resolved, true
	}
	resolved, ok := local.attribute(attr)
	if !ok || resolved == "" {
		return "", false
	}
	return resolved, true
}

func looksLikeBuildSpecPath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.ContainsAny(trimmed, "\n{") {
		return false
	}
	return strings.HasSuffix(trimmed, ".yml") || strings.HasSuffix(trimmed, ".yaml") || strings.HasSuffix(trimmed, ".json")
}
