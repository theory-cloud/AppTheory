package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	neturl "net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// CloudFormation custom resources.
//
// CDK builds several constructs the local runner needs on custom resources
// whose service token is a Lambda function: a deploy-time trigger
// (`Custom::Trigger`), the provider framework (`Custom::<name>` or
// `AWS::CloudFormation::CustomResource`), `Custom::AWS` SDK calls, and the
// bucket auto-delete handler (`Custom::S3AutoDeleteObjects`). CloudFormation
// invokes such a function with a request document and the handler reports its
// result by sending a response document to the request's pre-signed
// ResponseURL. The runner reproduces exactly that contract against the real
// handler, so a construct that migrates a secret, creates an SES rule set or
// propagates a genome runs the code it runs in a deployment.
//
// The request document carries RequestType, ResponseURL, StackId, RequestId,
// ResourceType, LogicalResourceId, ResourceProperties, PhysicalResourceId and,
// for an update, OldResourceProperties:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-requests.html
// The response document carries Status, Reason, PhysicalResourceId,
// StackId, RequestId, LogicalResourceId and Data; `Fn::GetAtt` on the custom
// resource returns the Data attributes:
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html

const (
	// customResourceTimeout bounds one custom-resource invocation. A provider
	// framework's own ServiceTimeout is honored when it is smaller. Lambda's
	// maximum invocation is 15 minutes.
	// https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
	customResourceTimeout = 15 * time.Minute
	// customResourceDeleteTimeout bounds the delete leg the session's
	// customResource.delete operation runs.
	customResourceDeleteTimeout = 2 * time.Minute
	// customResourceStatusSuccess and customResourceStatusFailed are the two
	// Status values a handler may report.
	// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
	customResourceStatusSuccess = "SUCCESS"
	customResourceStatusFailed  = "FAILED"
	// customResourceRequestPath is the path the response endpoint serves. The
	// handler PUTs its response document to <host>/<run>/<request id>.
	customResourceRequestPath = "/cfn-custom-resource/"
)

// customResourceResponse is the document a handler sends to the ResponseURL.
type customResourceResponse struct {
	Status             string         `json:"Status"`
	Reason             string         `json:"Reason"`
	PhysicalResourceID string         `json:"PhysicalResourceId"`
	StackID            string         `json:"StackId"`
	RequestID          string         `json:"RequestId"`
	LogicalResourceID  string         `json:"LogicalResourceId"`
	NoEcho             bool           `json:"NoEcho"`
	Data               map[string]any `json:"Data"`
}

// customResourceRequest is the document the runner sends to the handler.
type customResourceRequest struct {
	RequestType           string         `json:"RequestType"`
	ServiceToken          string         `json:"ServiceToken"`
	ResponseURL           string         `json:"ResponseURL"`
	StackID               string         `json:"StackId"`
	RequestID             string         `json:"RequestId"`
	ResourceType          string         `json:"ResourceType"`
	LogicalResourceID     string         `json:"LogicalResourceId"`
	ResourceProperties    map[string]any `json:"ResourceProperties"`
	OldResourceProperties map[string]any `json:"OldResourceProperties,omitempty"`
	PhysicalResourceID    string         `json:"PhysicalResourceId,omitempty"`
}

// deriveCustomResources records every custom resource the run can invoke. A
// custom resource the runner serves with its own implementation, or refuses,
// is reported in the same list so the type is never silently ignored.
//
// Each entry also carries its position in the stack's template dependency
// order. A template whose dependency graph is cyclic fails closed by name: the
// runner cannot know which resource CloudFormation would create first.
//
//nolint:gocognit // one branch per skip reason the derived resource reports.
func deriveCustomResources(spec *Spec, stacks []assemblyStack) error {
	for _, stack := range stacks {
		order, err := templateTopologicalOrder(stack)
		if err != nil {
			return err
		}
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			if !customResourceType(resource.Type) {
				continue
			}
			entry := CustomResourceSpec{
				LogicalID:  id,
				Stack:      stack.Name,
				Type:       resource.Type,
				Properties: resource.Properties,
				Order:      order[id],
			}
			if servedBy, ok := customResourceServedNatively[resource.Type]; ok {
				entry.ServedBy = servedBy
				spec.CustomResources = append(spec.CustomResources, entry)
				if entry.Refusal != "" {
					spec.Skipped = append(spec.Skipped, Skipped{
						LogicalID: id,
						Kind:      resource.Type,
						Reason:    entry.Refusal,
					})
				}
				continue
			}
			var props customResourceProperties
			if len(resource.Properties) > 0 {
				if err := json.Unmarshal(resource.Properties, &props); err != nil {
					spec.Skipped = append(spec.Skipped, Skipped{
						LogicalID: id,
						Kind:      resource.Type,
						Reason:    "the custom resource's properties are not a JSON object: " + err.Error(),
					})
					continue
				}
			}
			functionID, ok := findRefByType(props.ServiceToken, stack.resourceTypes(), typeLambdaFunction, "Arn")
			if !ok {
				spec.Skipped = append(spec.Skipped, Skipped{
					LogicalID: id,
					Kind:      resource.Type,
					Reason: "the service token is not a Lambda function ARN, so no handler can run locally " +
						"(https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html)",
				})
				continue
			}
			entry.Function = qualify(stacks, stack.Name, functionID)
			entry.Handler = customResourceHandlerTarget(stack, resource)
			if reason := customResourceMicrovmRefusal(stack, resource); reason != "" {
				entry.Refusal = reason
			} else if reason := customResourceHandlerRefusal(spec, entry.Function); reason != "" {
				entry.Refusal = reason
			}
			spec.CustomResources = append(spec.CustomResources, entry)
			if entry.Refusal != "" {
				spec.Skipped = append(spec.Skipped, Skipped{
					LogicalID: id,
					Kind:      resource.Type,
					Reason:    entry.Refusal,
				})
			}
		}
	}
	spec.DeployTimeFunctions = deployTimeClosure(stacks, deployTimeSeeds(spec, stacks))
	return nil
}

// deployTimeSeeds collects the functions a served custom resource names
// directly or through a Lambda reference in its properties; the closure
// completes them through the provider framework's environment edges.
func deployTimeSeeds(spec *Spec, stacks []assemblyStack) []string {
	seeds := make([]string, 0, len(spec.CustomResources))
	for _, entry := range spec.CustomResources {
		if entry.Refusal != "" || entry.ServedBy != "" {
			continue
		}
		seeds = append(seeds, entry.Function, entry.Handler)
		for _, stack := range stacks {
			if stack.Name != entry.Stack {
				continue
			}
			seeds = append(seeds, lambdaFunctionRefs(entry.Properties, stack, stacks)...)
			break
		}
	}
	return seeds
}

// customResourceHandlerRefusal reports why a service-token function cannot run
// locally. The type stays reported, never silently ignored: a handler whose
// code the assembly does not carry is refused by name instead of being started
// with no code.
func customResourceHandlerRefusal(spec *Spec, qualified string) string {
	function, ok := spec.Function(qualified)
	if !ok {
		return "the service token function " + qualified + " is not a Lambda function the runner derived"
	}
	if functionStartable(function) {
		return ""
	}
	reason := "the handler's code asset is not in the assembly, so no handler can run locally"
	if function.CodeProblem != "" {
		reason += ": " + function.CodeProblem
	}
	return reason
}

// customResourceProperties is the part of a custom resource's properties the
// runner reads directly.
type customResourceProperties struct {
	ServiceToken json.RawMessage `json:"ServiceToken"`
}

// customResourceMicrovmRefusal refuses a custom resource whose properties
// target a MicroVM type the runner refuses, so the MicroVM construct's
// supporting handler never runs against a provider that does not exist.
func customResourceMicrovmRefusal(stack assemblyStack, resource templateResource) string {
	for _, ref := range refsIn(resource.Properties) {
		target, ok := stack.Template.Resources[ref.ID]
		if !ok {
			continue
		}
		if reason, refused := refusedResourceReason(target.Type); refused {
			return "the resource targets " + target.Type + " (" + qualify(nil, stack.Name, ref.ID) + "); " + reason
		}
	}
	// A provider-framework construct that manages MicroVM images carries its
	// image properties inline (for example `MicrovmImageProperties`) and its
	// handler calls the MicroVM control plane. The image and its prune handler
	// are built and run by the MicroVM managed provider, which has no local
	// emulator, so the resource is refused before its handler is started.
	var properties map[string]any
	if len(resource.Properties) > 0 && json.Unmarshal(resource.Properties, &properties) == nil {
		for key := range properties {
			if strings.Contains(strings.ToLower(key), "microvm") {
				return "the resource's properties target the MicroVM managed provider (" + key + "); " +
					refusedMicrovmReason
			}
		}
	}
	return ""
}

// customResourceResponseServer is the run's response endpoint. A handler sends
// its response document to the pre-signed URL CloudFormation would have given
// it; the server keys the document by request id and wakes the waiter.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
type customResourceResponseServer struct {
	mu        sync.Mutex
	responses map[string]chan customResourceResponse
	// containerURL is the base URL a function container reaches the endpoint
	// at, over HTTPS from the run CA.
	containerURL string
}

// startCustomResourceResponses serves the response endpoint over HTTPS and
// records the URL function containers reach it at.
func (r *Runner) startCustomResourceResponses(ctx context.Context) error {
	server := &customResourceResponseServer{responses: map[string]chan customResourceResponse{}}
	url, err := r.startInternalHTTPS(ctx, "custom resource", server)
	if err != nil {
		return err
	}
	server.containerURL = url
	r.customResources = server
	if parsed, err := neturl.Parse(url); err == nil {
		r.cfnResponsePort = parsed.Port()
	}
	return nil
}

// close stops the endpoint. The server lifetime belongs to the run, so this
// only drops the waiters.
func (s *customResourceResponseServer) close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.responses = map[string]chan customResourceResponse{}
	s.mu.Unlock()
}

// expect registers the request id a response is awaited for.
func (s *customResourceResponseServer) expect(requestID string) chan customResourceResponse {
	channel := make(chan customResourceResponse, 1)
	s.mu.Lock()
	s.responses[requestID] = channel
	s.mu.Unlock()
	return channel
}

// forget drops a request id that never answered.
func (s *customResourceResponseServer) forget(requestID string) {
	s.mu.Lock()
	delete(s.responses, requestID)
	s.mu.Unlock()
}

// ServeHTTP accepts one response document. CloudFormation answers a PUT with
// 200; a handler treats any status below 400 as delivered.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
func (s *customResourceResponseServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPut {
		http.Error(writer, "the custom-resource response endpoint accepts PUT", http.StatusMethodNotAllowed)
		return
	}
	requestID := strings.Trim(strings.TrimPrefix(request.URL.Path, customResourceRequestPath), "/")
	var response customResourceResponse
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 1<<20))
	if err := decoder.Decode(&response); err != nil {
		http.Error(writer, "the response document is not JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	waiter, ok := s.responses[requestID]
	s.mu.Unlock()
	if !ok {
		http.Error(writer, "no custom-resource request is waiting for "+requestID, http.StatusNotFound)
		return
	}
	select {
	case waiter <- response:
	default:
	}
	writer.WriteHeader(http.StatusOK)
}

// responseURL is the pre-signed-shaped URL one request carries.
func (s *customResourceResponseServer) responseURL(requestID string) string {
	base := strings.TrimSuffix(s.containerURL, "/")
	return base + customResourceRequestPath + requestID
}

// requestIDFor is the request id a handler PUTs back: the run id makes two
// co-resident runs' endpoints distinguishable, and the logical id selects the
// waiter.
func requestIDFor(runID, logicalID string) string {
	return runID + "." + logicalID
}

// invokeCustomResources invokes every served custom resource with a Create
// request, in dependency order, and records the attributes each handler
// returned. A handler that reports FAILED fails the run with its Reason.
func (r *Runner) invokeCustomResources(ctx context.Context, spec *Spec) error {
	if r.customResources == nil {
		return nil
	}
	for _, resource := range dependencyOrder(spec.CustomResources) {
		if resource.Refusal != "" {
			r.logf("custom resource %s refused: %s", resource.LogicalID, resource.Refusal)
			continue
		}
		if resource.ServedBy != "" {
			r.logf("custom resource %s served by the runner: %s", resource.LogicalID, resource.ServedBy)
			continue
		}
		response, err := r.invokeCustomResource(ctx, spec, resource, "Create", "")
		if err != nil {
			return fmt.Errorf("custom resource %s (%s): %w", resource.LogicalID, resource.Type, err)
		}
		if strings.EqualFold(response.Status, customResourceStatusFailed) {
			reason := strings.TrimSpace(response.Reason)
			if reason == "" {
				reason = "the handler reported FAILED with no reason"
			}
			return fmt.Errorf("custom resource %s (%s) failed: %s", resource.LogicalID, resource.Type, reason)
		}
		r.recordCustomResourceData(resource, response)
		r.logf("custom resource %s (%s): %s %s", resource.LogicalID, resource.Type, response.Status, response.PhysicalResourceID)
	}
	return nil
}

// invokeCustomResource sends one request document to the handler and waits for
// its response document.
func (r *Runner) invokeCustomResource(
	ctx context.Context,
	spec *Spec,
	resource CustomResourceSpec,
	requestType string,
	physicalID string,
) (customResourceResponse, error) {
	invoker, ok := r.invokers[resource.Function]
	if !ok {
		return customResourceResponse{}, fmt.Errorf("the service token function %s is not running", resource.Function)
	}
	properties, err := r.resolveCustomResourceProperties(spec, resource)
	if err != nil {
		return customResourceResponse{}, err
	}
	requestID := requestIDFor(r.runID, resource.LogicalID)
	waiter := r.customResources.expect(requestID)
	defer r.customResources.forget(requestID)
	stackID := "arn:" + LocalPartition + ":cloudformation:" + LocalRegion + ":" + r.stackAccount(spec, resource.Stack) +
		":stack/" + resource.Stack + "/local"
	document := customResourceRequest{
		RequestType:        requestType,
		ServiceToken:       r.functionARN(spec, resource.Function),
		ResponseURL:        r.customResources.responseURL(requestID),
		StackID:            stackID,
		RequestID:          requestID,
		ResourceType:       resource.Type,
		LogicalResourceID:  resource.LogicalID,
		ResourceProperties: properties,
		PhysicalResourceID: physicalID,
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return customResourceResponse{}, fmt.Errorf("encode the request document: %w", err)
	}
	timeout := customResourceTimeout
	if declared := serviceTimeout(properties); declared > 0 && declared < timeout {
		timeout = declared
	}
	r.logf("custom resource %s: invoking %s (%s)", resource.LogicalID, resource.Function, requestType)
	done := make(chan error, 1)
	go func() {
		_, invokeErr := invoker.Invoke(ctx, payload)
		done <- invokeErr
	}()
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		select {
		case response := <-waiter:
			if response.RequestID == "" {
				response.RequestID = requestID
			}
			return response, nil
		case invokeErr := <-done:
			// The handler may have answered before its invocation returned, or
			// the provider framework may return without a response. Check the
			// response channel once more before deciding.
			select {
			case response := <-waiter:
				return response, nil
			default:
			}
			if invokeErr != nil {
				return customResourceResponse{}, fmt.Errorf("the handler invocation failed before it responded: %w", invokeErr)
			}
			// The CDK provider framework sends its response and then returns;
			// the invoker's result can arrive first. Wait for the response for a
			// short grace period before failing.
			select {
			case response := <-waiter:
				return response, nil
			case <-time.After(5 * time.Second):
			}
			return customResourceResponse{}, errors.New(
				"the handler returned without sending a response document to its ResponseURL " +
					"(https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html)")
		case <-waitCtx.Done():
			return customResourceResponse{}, fmt.Errorf(
				"the handler did not respond within %s (https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html)",
				timeout)
		}
	}
}

// serviceTimeout reads a provider framework's ServiceTimeout, in seconds.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html
func serviceTimeout(properties map[string]any) time.Duration {
	for _, name := range []string{"ServiceTimeout", "Timeout"} {
		value, ok := properties[name]
		if !ok {
			continue
		}
		switch typed := value.(type) {
		case float64:
			return time.Duration(typed) * time.Second
		case string:
			var seconds int
			if _, err := fmt.Sscanf(typed, "%d", &seconds); err == nil && seconds > 0 {
				return time.Duration(seconds) * time.Second
			}
		}
	}
	return 0
}

// resolveCustomResourceProperties resolves a custom resource's property
// document against the assembly. A property the runner cannot resolve fails the
// resource by name instead of sending a half-resolved document to the handler.
func (r *Runner) resolveCustomResourceProperties(spec *Spec, resource CustomResourceSpec) (map[string]any, error) {
	if len(resource.Properties) == 0 {
		return map[string]any{}, nil
	}
	var raw any
	if err := json.Unmarshal(resource.Properties, &raw); err != nil {
		return nil, fmt.Errorf("parse the resource properties: %w", err)
	}
	resolved, err := r.resolveJSONValue(spec, resource.Stack, raw)
	if err != nil {
		return nil, err
	}
	object, ok := resolved.(map[string]any)
	if !ok {
		return nil, errors.New("the resource properties are not a JSON object")
	}
	return object, nil
}

// recordCustomResourceData keeps a handler's Data attributes so a GetAtt on the
// custom resource resolves to them, the way `Fn::GetAtt` returns a custom
// resource's Data values.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
func (r *Runner) recordCustomResourceData(resource CustomResourceSpec, response customResourceResponse) {
	if r.customResourceData == nil {
		r.customResourceData = map[string]map[string]string{}
	}
	if r.customResourcePhysicalIDs == nil {
		r.customResourcePhysicalIDs = map[string]string{}
	}
	key := resource.Stack + "/" + resource.LogicalID
	attributes := map[string]string{}
	for name, value := range response.Data {
		switch typed := value.(type) {
		case string:
			attributes[name] = typed
		case float64, bool:
			attributes[name] = fmt.Sprint(typed)
		default:
			encoded, err := json.Marshal(typed)
			if err == nil {
				attributes[name] = string(encoded)
			}
		}
	}
	if response.PhysicalResourceID != "" {
		attributes["PhysicalResourceId"] = response.PhysicalResourceID
		r.customResourcePhysicalIDs[key] = response.PhysicalResourceID
	}
	r.customResourceData[key] = attributes
}

// customResourceAttribute returns a Data attribute a handler reported.
func (r *Runner) customResourceAttribute(stack, logicalID, attribute string) (string, bool) {
	attributes, ok := r.customResourceData[stack+"/"+logicalID]
	if !ok {
		return "", false
	}
	value, ok := attributes[attribute]
	return value, ok
}

// dependencyOrder sorts custom resources into their stacks' template
// dependency order. The derived Order carries the topological position (an
// explicit DependsOn chain through a non-custom resource counts); specs
// without one fall back to a direct property reference and then to logical-id
// order, which is the only tie-break.
func dependencyOrder(resources []CustomResourceSpec) []CustomResourceSpec {
	ordered := make([]CustomResourceSpec, len(resources))
	copy(ordered, resources)
	sort.SliceStable(ordered, func(i, j int) bool {
		left, right := ordered[i], ordered[j]
		if left.Stack != right.Stack {
			return left.Stack < right.Stack
		}
		if left.Order != right.Order {
			return left.Order < right.Order
		}
		leftDepends := referencesLogicalID(left.Properties, right.LogicalID)
		rightDepends := referencesLogicalID(right.Properties, left.LogicalID)
		switch {
		case leftDepends && !rightDepends:
			return false
		case rightDepends && !leftDepends:
			return true
		}
		return left.LogicalID < right.LogicalID
	})
	return ordered
}

// referencesLogicalID reports whether a property document names a logical id.
func referencesLogicalID(raw json.RawMessage, logicalID string) bool {
	if logicalID == "" {
		return false
	}
	for _, ref := range refsIn(raw) {
		if ref.ID == logicalID {
			return true
		}
	}
	return false
}

// customResourceDelete invokes one resource's Delete handler, which is how a
// BucketDeployment-like auto-delete construct removes its objects. The session
// operation `customResource.delete` runs it; `run` and `session` shutdown do
// not, because the runner owns the teardown of the run's own backends.
func (r *Runner) customResourceDelete(ctx context.Context, spec *Spec, logicalID string) (map[string]any, error) {
	resource, ok := customResourceByLogicalID(spec, logicalID)
	if !ok {
		return nil, fmt.Errorf("no custom resource %q in the assembly", logicalID)
	}
	if resource.Refusal != "" {
		return nil, fmt.Errorf("custom resource %s is refused: %s", logicalID, resource.Refusal)
	}
	if resource.ServedBy != "" {
		if resource.Type == typeBucketAutoDelete {
			return r.emptyAutoDeleteBucket(ctx, spec, resource)
		}
		return nil, fmt.Errorf("custom resource %s is served by the runner (%s) and has no handler to invoke", logicalID, resource.ServedBy)
	}
	key := resource.Stack + "/" + resource.LogicalID
	previous := r.customResourcePhysicalIDs[key]
	if previous == "" {
		previous = requestIDFor(r.runID, resource.LogicalID)
	}
	deleteCtx, cancel := context.WithTimeout(ctx, customResourceDeleteTimeout)
	defer cancel()
	response, err := r.invokeCustomResource(deleteCtx, spec, resource, "Delete", previous)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"logicalId":          resource.LogicalID,
		"status":             response.Status,
		"reason":             response.Reason,
		"physicalResourceId": response.PhysicalResourceID,
	}, nil
}

// customResourceByLogicalID finds a derived custom resource.
func customResourceByLogicalID(spec *Spec, logicalID string) (CustomResourceSpec, bool) {
	for _, resource := range spec.CustomResources {
		if resource.LogicalID == logicalID {
			return resource, true
		}
	}
	return CustomResourceSpec{}, false
}

// customResourceHandlerTarget resolves the function a Custom::Trigger's
// HandlerArn names. The trigger's provider invokes it through Lambda, so the run
// must start it; a Lambda version's FunctionName names the function behind it.
//
// https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.triggers-readme.html
func customResourceHandlerTarget(stack assemblyStack, resource templateResource) string {
	var props struct {
		HandlerArn json.RawMessage `json:"HandlerArn"`
	}
	if len(resource.Properties) == 0 {
		return ""
	}
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return ""
	}
	types := stack.resourceTypes()
	if functionID, ok := findRefByType(props.HandlerArn, types, typeLambdaFunction, "Arn"); ok {
		return qualify(nil, stack.Name, functionID)
	}
	versionID, ok := directRefID(props.HandlerArn)
	if !ok {
		return ""
	}
	version, ok := stack.Template.Resources[versionID]
	if !ok || version.Type != "AWS::Lambda::Version" {
		return ""
	}
	var versionProps struct {
		FunctionName json.RawMessage `json:"FunctionName"`
	}
	if err := json.Unmarshal(version.Properties, &versionProps); err != nil {
		return ""
	}
	if functionID, ok := findRefByType(versionProps.FunctionName, types, typeLambdaFunction, "Arn"); ok {
		return qualify(nil, stack.Name, functionID)
	}
	return ""
}

// emptyAutoDeleteBucket serves a bucket auto-delete resource's delete leg. The
// CDK handler empties the bucket by listing its object versions, and s3proxy's
// store does not implement ListObjectVersions; the runner performs the same
// effect with the S3 API the store does implement, and reports the response the
// handler would have sent.
//
// https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3-readme.html#automatic-object-deletion
//
//nolint:gocyclo // one branch per listing page and per delete result.
func (r *Runner) emptyAutoDeleteBucket(ctx context.Context, spec *Spec, resource CustomResourceSpec) (map[string]any, error) {
	properties, err := r.resolveCustomResourceProperties(spec, resource)
	if err != nil {
		return nil, err
	}
	bucket := ""
	for _, key := range []string{"BucketName", "Bucket"} {
		if value, ok := properties[key].(string); ok && value != "" {
			bucket = value
		}
	}
	if bucket == "" {
		return nil, fmt.Errorf("the auto-delete resource names no bucket")
	}
	backend, ok := r.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil, fmt.Errorf("the auto-delete resource needs the s3proxy backend (--backend s3proxy)")
	}
	client := newS3Client(backend.HostURL)
	deleted := 0
	if r.s3Front != nil && r.s3Front.versions.enabled(bucket) {
		verdict, emptyErr := r.emptyVersionedBucket(ctx, client, resource, bucket)
		return verdict, emptyErr
	}
	var continuation *string
	for {
		listing, listErr := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			ContinuationToken: continuation,
		})
		if listErr != nil {
			return nil, fmt.Errorf("list the objects of bucket %s: %w", bucket, listErr)
		}
		for _, object := range listing.Contents {
			if _, deleteErr := client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket: aws.String(bucket),
				Key:    object.Key,
			}); deleteErr != nil {
				return nil, fmt.Errorf("delete %s from bucket %s: %w", aws.ToString(object.Key), bucket, deleteErr)
			}
			deleted++
		}
		if listing.IsTruncated == nil || !*listing.IsTruncated || listing.NextContinuationToken == nil {
			break
		}
		continuation = listing.NextContinuationToken
	}
	r.logf("custom resource %s: emptied bucket %s (%d object(s)) for its delete leg", resource.LogicalID, bucket, deleted)
	return map[string]any{
		"logicalId":          resource.LogicalID,
		"status":             customResourceStatusSuccess,
		"reason":             "the runner emptied the bucket for the auto-delete handler's delete leg",
		"physicalResourceId": bucket,
		"deletedObjects":     deleted,
	}, nil
}

// emptyVersionedBucket is the auto-delete leg for a version-enabled bucket. A
// versioned bucket is emptied by deleting every version, the way the CDK
// handler's own version listing does; a plain object delete would only add
// delete markers and leave the versions behind, so RemoveBucket could never
// succeed.
func (r *Runner) emptyVersionedBucket(
	ctx context.Context,
	client *s3.Client,
	resource CustomResourceSpec,
	bucket string,
) (map[string]any, error) {
	deleted := 0
	var keyMarker, versionMarker *string
	for {
		listing, listErr := client.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{
			Bucket:          aws.String(bucket),
			KeyMarker:       keyMarker,
			VersionIdMarker: versionMarker,
		})
		if listErr != nil {
			return nil, fmt.Errorf("list the versions of bucket %s: %w", bucket, listErr)
		}
		for _, version := range listing.Versions {
			if _, deleteErr := client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket:    aws.String(bucket),
				Key:       version.Key,
				VersionId: version.VersionId,
			}); deleteErr != nil {
				return nil, fmt.Errorf("delete version %s of %s from bucket %s: %w", aws.ToString(version.VersionId), aws.ToString(version.Key), bucket, deleteErr)
			}
			deleted++
		}
		for _, marker := range listing.DeleteMarkers {
			if _, deleteErr := client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket:    aws.String(bucket),
				Key:       marker.Key,
				VersionId: marker.VersionId,
			}); deleteErr != nil {
				return nil, fmt.Errorf("delete delete-marker %s of %s from bucket %s: %w", aws.ToString(marker.VersionId), aws.ToString(marker.Key), bucket, deleteErr)
			}
			deleted++
		}
		if listing.IsTruncated == nil || !*listing.IsTruncated || listing.NextKeyMarker == nil {
			break
		}
		keyMarker, versionMarker = listing.NextKeyMarker, listing.NextVersionIdMarker
	}
	r.logf("custom resource %s: emptied versioned bucket %s (%d version(s)) for its delete leg", resource.LogicalID, bucket, deleted)
	return map[string]any{
		"logicalId":          resource.LogicalID,
		"status":             customResourceStatusSuccess,
		"reason":             "the runner emptied the versioned bucket for the auto-delete handler's delete leg",
		"physicalResourceId": bucket,
		"deletedObjects":     deleted,
	}, nil
}
