package localrunner

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// Lambda@Edge, CloudFront KeyValueStore and the viewer-country run option.

// CloudFrontEdgeFunctions returns the Lambda functions the served
// distributions associate through LambdaFunctionAssociations. They start with
// the rest of the run because no route or event source targets them.
func (s *Spec) CloudFrontEdgeFunctions() []string {
	seen := map[string]struct{}{}
	for _, distribution := range s.ServableCloudFront() {
		for _, behavior := range append([]*localcloudfront.Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...) {
			if behavior == nil {
				continue
			}
			for _, association := range behavior.EdgeLambdas {
				if association.Function != "" {
					seen[association.Function] = struct{}{}
				}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// edgeVersions maps each Lambda@Edge version logical id to the function behind
// it.
func edgeVersions(spec *Spec) map[string]string {
	versions := map[string]string{}
	for _, distribution := range spec.ServableCloudFront() {
		for _, behavior := range append([]*localcloudfront.Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...) {
			if behavior == nil {
				continue
			}
			for _, association := range behavior.EdgeLambdas {
				if association.Version != "" && association.Function != "" {
					versions[association.Version] = association.Function
				}
			}
		}
	}
	return versions
}

// edgeInvokerAdapter invokes a Lambda@Edge version through the same container
// the runner starts for every other Lambda function.
type edgeInvokerAdapter struct {
	versions map[string]string
	invokers map[string]Invoker
}

func (a *edgeInvokerAdapter) InvokeEdge(
	ctx context.Context,
	versionLogicalID string,
	timeout time.Duration,
	payload []byte,
) ([]byte, error) {
	functionID, ok := a.versions[versionLogicalID]
	if !ok {
		return nil, fmt.Errorf("Lambda@Edge version %q is not associated with a function in this assembly", versionLogicalID)
	}
	invoker, ok := a.invokers[functionID]
	if !ok {
		return nil, fmt.Errorf("Lambda@Edge function %s is not running", functionID)
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return invoker.Invoke(runCtx, payload)
}

// materializeKeyValueStores loads each served distribution's key value stores
// from the asset the cloud assembly carries, in the documented import file
// format, and binds them to the functions that read them.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-create-s3-kvp.html
//
//nolint:gocognit,gocyclo // one pass per store and per function association
func (r *Runner) materializeKeyValueStores(spec *Spec) error {
	if len(spec.CloudFrontKeyValueStores) == 0 && !anyFunctionNamesAStore(spec) {
		return nil
	}
	assets := map[string]map[string]string{}
	now := r.now()
	for _, store := range spec.CloudFrontKeyValueStores {
		if !store.Servable() || store.ObjectKey == "" {
			continue
		}
		sources, err := r.assetSources(spec, store.Stack, assets)
		if err != nil {
			store.Refusals = append(store.Refusals, fmt.Sprintf(
				"the assembly carries no asset manifest entry for the import source: %v", err))
			continue
		}
		source, ok := sources[store.ObjectKey]
		if !ok {
			for objectKey, candidate := range sources {
				if strings.HasSuffix(objectKey, store.ObjectKey) || strings.HasSuffix(store.ObjectKey, objectKey) {
					source, ok = candidate, true
					break
				}
			}
		}
		if !ok {
			store.Refusals = append(store.Refusals, fmt.Sprintf(
				"the import source object %q is not an asset in the assembly; use ImportSource.fromAsset or fromInline", store.ObjectKey))
			continue
		}
		payload, err := os.ReadFile(source) //nolint:gosec // assembly path derived from the synthesized app
		if err != nil {
			return fmt.Errorf("read key-value store %s import file: %w", store.LogicalID, err)
		}
		if err := store.LoadImportFile(payload, now); err != nil {
			return err
		}
	}
	for _, function := range spec.CloudFrontFunctions {
		if function.KeyValueStore == "" {
			continue
		}
		store, ok := spec.cloudFrontTopology.KeyValueStore(function.KeyValueStore)
		if !ok {
			function.Refusals = append(function.Refusals,
				fmt.Sprintf("KeyValueStoreAssociations names %q, which is not in the assembly", function.KeyValueStore))
			continue
		}
		if !store.Servable() {
			function.Refusals = append(function.Refusals, fmt.Sprintf(
				"key value store %s is refused: %s", store.LogicalID, strings.Join(store.Refusals, "; ")))
			continue
		}
		function.AttachStore(store)
	}
	// A refusal added here must refuse the distribution that uses the function
	// or the store, exactly as a parse-time refusal does.
	for _, distribution := range spec.CloudFront {
		if len(distribution.Refusals) > 0 {
			continue
		}
		for _, behavior := range append([]*localcloudfront.Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...) {
			if behavior == nil {
				continue
			}
			for _, functionID := range []string{behavior.ViewerRequestFunction, behavior.ViewerResponseFunction} {
				if functionID == "" {
					continue
				}
				function, ok := spec.cloudFrontTopology.Function(functionID)
				if !ok || len(function.Refusals) == 0 {
					continue
				}
				distribution.Refusals = append(distribution.Refusals,
					fmt.Sprintf("function %s: %s", functionID, strings.Join(function.Refusals, "; ")))
			}
		}
	}
	return nil
}

// validateViewerCountry checks the --viewer-country value: an ISO 3166-1
// alpha-2 code in upper case. An empty value leaves the viewer's location
// undetermined, which CloudFront serves.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/georestrictions.html
func validateViewerCountry(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	if len(trimmed) != 2 || strings.ToUpper(trimmed) != trimmed {
		return "", fmt.Errorf("viewer country %q is not an ISO 3166-1 alpha-2 code in upper case (for example US or DE)", value)
	}
	for _, r := range trimmed {
		if r < 'A' || r > 'Z' {
			return "", fmt.Errorf("viewer country %q is not an ISO 3166-1 alpha-2 code in upper case (for example US or DE)", value)
		}
	}
	return trimmed, nil
}

// cloudFrontSecurityReport renders the local key material and stores both plan
// and session describe report.
func cloudFrontSecurityReport(spec *Spec) map[string]any {
	if spec == nil {
		return nil
	}
	keys := make([]map[string]any, 0, len(spec.CloudFrontPublicKeys))
	for _, key := range spec.CloudFrontPublicKeys {
		keys = append(keys, map[string]any{
			"logicalId": key.LogicalID,
			"name":      key.Name,
			"keyPairId": key.ID,
			"refusals":  key.Refusals,
		})
	}
	groups := make([]map[string]any, 0, len(spec.CloudFrontKeyGroups))
	for _, group := range spec.CloudFrontKeyGroups {
		groups = append(groups, map[string]any{
			"logicalId": group.LogicalID,
			"name":      group.Name,
			"items":     group.Items,
			"refusals":  group.Refusals,
		})
	}
	stores := make([]map[string]any, 0, len(spec.CloudFrontKeyValueStores))
	for _, store := range spec.CloudFrontKeyValueStores {
		stores = append(stores, map[string]any{
			"logicalId": store.LogicalID,
			"name":      store.Name,
			"keyCount":  store.KeyCount(),
			"refusals":  store.Refusals,
		})
	}
	if len(keys) == 0 && len(groups) == 0 && len(stores) == 0 {
		return nil
	}
	return map[string]any{
		"publicKeys":     keys,
		"keyGroups":      groups,
		"keyValueStores": stores,
	}
}

// distributionSecurityReport renders one distribution's edge and viewer rules.
func distributionSecurityReport(distribution *localcloudfront.Distribution) map[string]any {
	if distribution == nil {
		return nil
	}
	report := map[string]any{}
	if distribution.GeoRestriction != nil {
		report["geoRestriction"] = distribution.GeoRestriction
	}
	behaviors := append([]*localcloudfront.Behavior{distribution.DefaultBehavior}, distribution.CacheBehaviors...)
	edge := []map[string]any{}
	signed := []map[string]any{}
	fle := []map[string]any{}
	for _, behavior := range behaviors {
		if behavior == nil {
			continue
		}
		for _, association := range behavior.EdgeLambdas {
			edge = append(edge, map[string]any{
				"eventType": association.EventType,
				"version":   association.Version,
				"function":  association.Function,
			})
		}
		if behavior.TrustedKeyGroups != nil && behavior.TrustedKeyGroups.Enabled {
			signed = append(signed, map[string]any{
				"pathPattern": behavior.PathPattern,
				"keyGroups":   behavior.TrustedKeyGroups.Items,
			})
		}
		if behavior.FieldLevelEncryptionID != "" {
			fle = append(fle, map[string]any{
				"pathPattern": behavior.PathPattern,
				"config":      behavior.FieldLevelEncryptionID,
			})
		}
	}
	if len(edge) > 0 {
		report["edgeLambdas"] = edge
	}
	if len(signed) > 0 {
		report["signedAccess"] = signed
	}
	if len(fle) > 0 {
		report["fieldLevelEncryption"] = fle
	}
	if len(report) == 0 {
		return nil
	}
	return report
}

// anyFunctionNamesAStore reports whether a CloudFront Function association
// names a store, so the materialization can refuse a store that is missing from
// the assembly.
func anyFunctionNamesAStore(spec *Spec) bool {
	for _, function := range spec.CloudFrontFunctions {
		if function.KeyValueStore != "" {
			return true
		}
	}
	return false
}

// refreshCloudFrontSkips recomputes the CloudFront and Lambda@Edge entries of
// the skip report after the post-parse steps: an --origin mapping can make a
// distribution servable, which starts its Lambda@Edge functions, and a
// key-value store materialization can refuse one.
func refreshCloudFrontSkips(spec *Spec) {
	served := map[string]bool{}
	for _, id := range spec.RuntimeFunctions() {
		served[id] = true
	}
	distributions := map[string]*localcloudfront.Distribution{}
	for _, distribution := range spec.CloudFront {
		distributions[distribution.LogicalID] = distribution
	}
	out := make([]Skipped, 0, len(spec.Skipped))
	for _, skipped := range spec.Skipped {
		switch skipped.Kind {
		case typeLambdaFunction:
			if served[skipped.LogicalID] {
				continue
			}
		case "cloudfront distribution":
			if distribution, ok := distributions[skipped.LogicalID]; ok && distribution.Servable() {
				continue
			}
		}
		out = append(out, skipped)
	}
	spec.Skipped = out
	known := map[string]bool{}
	for _, skipped := range spec.Skipped {
		known[skipped.LogicalID] = true
	}
	for _, distribution := range spec.CloudFront {
		if distribution.Servable() || known[distribution.LogicalID] {
			continue
		}
		spec.Skipped = append(spec.Skipped, Skipped{
			LogicalID: distribution.LogicalID,
			Kind:      "cloudfront distribution",
			Reason:    strings.Join(distribution.Refusals, "; "),
		})
	}
}
