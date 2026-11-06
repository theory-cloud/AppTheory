package localcloudfront

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// CloudFront KeyValueStore.
//
// "Your CloudFront function must use JavaScript runtime 2.0" and a function can
// read a store through the cloudfront module:
//
//	import cf from 'cloudfront';
//	const kvsHandle = cf.kvs();
//	const value = await kvsHandle.get('key');
//
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html

// Quotas on key value stores: a key is at most 512 bytes, a value at most 1 KB,
// an individual store at most 5 MB and a function can be associated with one
// store.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-keyvaluestores
const (
	kvsMaxKeyBytes   = 512
	kvsMaxValueBytes = 1024
	kvsMaxStoreBytes = 5 << 20
	kvsMaxStores     = 1
)

// KeyValueStore is one AWS::CloudFront::KeyValueStore, materialized from the
// import source the assembly carries.
type KeyValueStore struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Name      string `json:"name,omitempty"`
	Comment   string `json:"comment,omitempty"`
	// SourceType is the import source type; CloudFront accepts S3.
	SourceType string `json:"sourceType,omitempty"`
	// ObjectKey is the S3 object key the import source names.
	ObjectKey string `json:"objectKey,omitempty"`
	// Values is the materialized store content. The runner fills it from the
	// assembly asset before the distribution is served.
	Values map[string]string `json:"-"`
	// CreatedAt and UpdatedAt are the run's timestamps for meta().
	CreatedAt time.Time `json:"-"`
	UpdatedAt time.Time `json:"-"`

	Reported []string `json:"reported,omitempty"`
	Refusals []string `json:"refusals,omitempty"`
}

// Servable reports whether the store can be used.
func (s *KeyValueStore) Servable() bool { return s != nil && len(s.Refusals) == 0 }

// KeyCount returns the number of keys the store holds.
func (s *KeyValueStore) KeyCount() int {
	if s == nil {
		return 0
	}
	return len(s.Values)
}

// Keys returns the store's keys in sorted order.
func (s *KeyValueStore) Keys() []string {
	keys := make([]string, 0, len(s.Values))
	for key := range s.Values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// LoadImportFile parses the documented key-value pair import file:
// {"data": [{"key": "...", "value": "..."}]}.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-create-s3-kvp.html
func (s *KeyValueStore) LoadImportFile(payload []byte, now time.Time) error {
	var document struct {
		Data []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return fmt.Errorf("key-value store %s import file is not {\"data\":[{\"key\",\"value\"}]}: %w", s.LogicalID, err)
	}
	values := make(map[string]string, len(document.Data))
	total := 0
	for position, entry := range document.Data {
		if entry.Key == "" {
			return fmt.Errorf("key-value store %s data[%d] has no key", s.LogicalID, position)
		}
		if len(entry.Key) > kvsMaxKeyBytes {
			return fmt.Errorf("key-value store %s key %q is %d bytes; CloudFront allows %d",
				s.LogicalID, entry.Key, len(entry.Key), kvsMaxKeyBytes)
		}
		if len(entry.Value) > kvsMaxValueBytes {
			return fmt.Errorf("key-value store %s value for key %q is %d bytes; CloudFront allows %d",
				s.LogicalID, entry.Key, len(entry.Value), kvsMaxValueBytes)
		}
		if _, exists := values[entry.Key]; exists {
			return fmt.Errorf("key-value store %s import file repeats key %q", s.LogicalID, entry.Key)
		}
		values[entry.Key] = entry.Value
		total += len(entry.Key) + len(entry.Value)
	}
	if total > kvsMaxStoreBytes {
		return fmt.Errorf("key-value store %s is %d bytes; CloudFront allows %d", s.LogicalID, total, kvsMaxStoreBytes)
	}
	s.Values = values
	if s.CreatedAt.IsZero() {
		s.CreatedAt = now
	}
	s.UpdatedAt = now
	return nil
}

func parseKeyValueStore(stack, id string, resource Resource, index *resourceIndex) (*KeyValueStore, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	store := &KeyValueStore{LogicalID: index.qualified(stack, id), Stack: stack}
	for _, name := range sortedKeys(properties) {
		switch name {
		case propertyComment:
			if err := json.Unmarshal(properties[name], &store.Comment); err != nil {
				return nil, fmt.Errorf("%s/%s: Comment: %w", stack, id, err)
			}
			store.Reported = append(store.Reported, reportProperty("key-value store", name))
		case "ImportSource":
			source, problem := parseKVSImportSource(properties[name], stack, index)
			if problem != "" {
				store.Refusals = append(store.Refusals, problem)
				continue
			}
			store.SourceType = source.sourceType
			store.ObjectKey = source.objectKey
		case propertyName:
			if err := json.Unmarshal(properties[name], &store.Name); err != nil {
				return nil, fmt.Errorf("%s/%s: Name: %w", stack, id, err)
			}
			store.Reported = append(store.Reported, reportProperty("key-value store", name))
		default:
			store.Refusals = append(store.Refusals, fmt.Sprintf("property %q is not understood", name))
		}
	}
	return store, nil
}

type kvsImportSource struct {
	sourceType string
	objectKey  string
}

//nolint:gocognit // one branch per import source field
func parseKVSImportSource(raw json.RawMessage, _ string, _ *resourceIndex) (kvsImportSource, string) {
	fields, err := decodeObject(raw)
	if err != nil {
		return kvsImportSource{}, "ImportSource is not an object"
	}
	source := kvsImportSource{}
	var arnRaw json.RawMessage
	for _, name := range sortedKeys(fields) {
		switch name {
		case "SourceType":
			if err := json.Unmarshal(fields[name], &source.sourceType); err != nil {
				return kvsImportSource{}, "ImportSource.SourceType is not a string"
			}
		case "SourceArn":
			arnRaw = fields[name]
		default:
			return kvsImportSource{}, fmt.Sprintf("ImportSource property %q is not understood", name)
		}
	}
	if source.sourceType != "S3" {
		return kvsImportSource{}, fmt.Sprintf("ImportSource.SourceType %q is not S3; CloudFront imports a key value store from S3", source.sourceType)
	}
	objectKey, problem := resolveS3ObjectKey(arnRaw)
	if problem != "" {
		return kvsImportSource{}, problem
	}
	source.objectKey = objectKey
	return source, ""
}

// resolveS3ObjectKey reads the object key from an S3 ARN expression. The
// assembly's assets manifest maps the object key to the asset file, so the
// gateway reads the same bytes CloudFront would import.
func resolveS3ObjectKey(raw json.RawMessage) (string, string) {
	if len(raw) == 0 {
		return "", "ImportSource.SourceArn is missing"
	}
	var literal string
	if err := json.Unmarshal(raw, &literal); err != nil {
		joined, problem := flattenStringExpression(raw)
		if problem != "" {
			return "", "ImportSource.SourceArn " + problem
		}
		literal = joined
	}
	index := strings.LastIndex(literal, "/")
	if index < 0 || index == len(literal)-1 {
		return "", fmt.Sprintf("ImportSource.SourceArn %q names no S3 object key", literal)
	}
	return literal[index+1:], ""
}

// flattenStringExpression joins the literal parts of Fn::Join and Fn::Sub. A
// Ref to another resource contributes an empty string: the object key is the
// final path segment the asset manifest matches.
//
//nolint:gocognit // one branch per expression form
func flattenStringExpression(raw json.RawMessage) (string, string) {
	var expression map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expression); err != nil || len(expression) != 1 {
		return "", "is not a string or a supported expression"
	}
	for key, value := range expression {
		switch key {
		case "Fn::Join":
			var parts []json.RawMessage
			if err := json.Unmarshal(value, &parts); err != nil || len(parts) != 2 {
				return "", "Fn::Join is not [delimiter, parts]"
			}
			var delimiter string
			if err := json.Unmarshal(parts[0], &delimiter); err != nil {
				return "", "Fn::Join delimiter is not a string"
			}
			var values []json.RawMessage
			if err := json.Unmarshal(parts[1], &values); err != nil {
				return "", "Fn::Join parts are not a list"
			}
			var out strings.Builder
			for position, part := range values {
				var text string
				if err := json.Unmarshal(part, &text); err == nil {
					if position > 0 {
						out.WriteString(delimiter)
					}
					out.WriteString(text)
					continue
				}
				if position > 0 {
					out.WriteString(delimiter)
				}
			}
			return out.String(), ""
		case "Fn::Sub":
			var text string
			if err := json.Unmarshal(value, &text); err == nil {
				return text, ""
			}
			return "", "Fn::Sub is not a string"
		default:
			return "", fmt.Sprintf("expression %s is not a string the local gateway understands", compactJSON(raw))
		}
	}
	return "", "is empty"
}

// parseKeyValueStoreAssociations reads FunctionConfig.KeyValueStoreAssociations.
// "You can associate only one key value store with a function."
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-associate.html
func parseKeyValueStoreAssociations(raw json.RawMessage, stack string, index *resourceIndex, runtime string) ([]string, []string) {
	var refusals []string
	if runtime != runtimeJS20 {
		refusals = append(refusals, fmt.Sprintf(
			"runtime %q cannot read a key value store; a CloudFront function must use JavaScript runtime 2.0", runtime))
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		items, problem := unwrapItems(raw, "KeyValueStoreAssociations")
		if problem != "" {
			return nil, append(refusals, problem)
		}
		values = items
	}
	stores := make([]string, 0, len(values))
	for position, value := range values {
		fields, err := decodeObject(value)
		if err != nil {
			refusals = append(refusals, fmt.Sprintf("KeyValueStoreAssociations[%d] is not an object", position))
			continue
		}
		var storeID string
		for _, name := range sortedKeys(fields) {
			if name != "KeyValueStoreARN" {
				refusals = append(refusals, fmt.Sprintf("KeyValueStoreAssociations[%d] property %q is not understood", position, name))
				continue
			}
			qualified, ok := resolveResourceRef(fields[name], stack, index)
			if !ok {
				refusals = append(refusals, fmt.Sprintf(
					"KeyValueStoreAssociations[%d].KeyValueStoreARN does not reference an AWS::CloudFront::KeyValueStore in this assembly", position))
				continue
			}
			storeID = qualified
		}
		if storeID == "" {
			refusals = append(refusals, fmt.Sprintf("KeyValueStoreAssociations[%d] has no resolvable KeyValueStoreARN", position))
			continue
		}
		stores = append(stores, storeID)
	}
	if len(stores) > kvsMaxStores {
		refusals = append(refusals, fmt.Sprintf(
			"the function is associated with %d key value stores; CloudFront allows one per function", len(stores)))
	}
	return stores, refusals
}
