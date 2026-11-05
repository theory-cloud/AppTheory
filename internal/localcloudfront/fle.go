package localcloudfront

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

// Field-level encryption.
//
// "With field-level encryption, you can enable your users to securely upload
// sensitive information to your web servers. The sensitive information provided
// by your users is encrypted at the edge ... specify the set of fields in POST
// requests that you want to be encrypted ... You can encrypt up to 10 data
// fields in a request."
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html

const formContentType = "application/x-www-form-urlencoded"

// FieldLevelEncryptionConfig is one AWS::CloudFront::FieldLevelEncryptionConfig.
type FieldLevelEncryptionConfig struct {
	LogicalID                string                    `json:"logicalId"`
	Stack                    string                    `json:"stack"`
	Comment                  string                    `json:"comment,omitempty"`
	ContentTypeProfileConfig *ContentTypeProfileConfig `json:"contentTypeProfileConfig,omitempty"`
	QueryArgProfileConfig    *QueryArgProfileConfig    `json:"queryArgProfileConfig,omitempty"`
	Reported                 []string                  `json:"reported,omitempty"`
	Refusals                 []string                  `json:"refusals,omitempty"`
}

// Servable reports whether the configuration can be applied.
func (c *FieldLevelEncryptionConfig) Servable() bool { return c != nil && len(c.Refusals) == 0 }

// ContentTypeProfileConfig maps the form content type to a profile.
type ContentTypeProfileConfig struct {
	ForwardWhenContentTypeIsUnknown bool                 `json:"forwardWhenContentTypeIsUnknown"`
	Profiles                        []ContentTypeProfile `json:"profiles,omitempty"`
}

// ContentTypeProfile is one ContentTypeProfiles entry.
type ContentTypeProfile struct {
	ContentType string `json:"contentType"`
	Format      string `json:"format"`
	ProfileID   string `json:"profileId"`
}

// QueryArgProfileConfig maps the fle-profile query argument to a profile.
type QueryArgProfileConfig struct {
	ForwardWhenQueryArgProfileIsUnknown bool              `json:"forwardWhenQueryArgProfileIsUnknown"`
	Profiles                            []QueryArgProfile `json:"profiles,omitempty"`
}

// QueryArgProfile is one QueryArgProfiles entry.
type QueryArgProfile struct {
	QueryArg  string `json:"queryArg"`
	ProfileID string `json:"profileId"`
}

// FieldLevelEncryptionProfile is one
// AWS::CloudFront::FieldLevelEncryptionProfile.
type FieldLevelEncryptionProfile struct {
	LogicalID string             `json:"logicalId"`
	Stack     string             `json:"stack"`
	Name      string             `json:"name,omitempty"`
	Comment   string             `json:"comment,omitempty"`
	Entities  []EncryptionEntity `json:"entities,omitempty"`
	Reported  []string           `json:"reported,omitempty"`
	Refusals  []string           `json:"refusals,omitempty"`
}

// Servable reports whether the profile can be applied.
func (p *FieldLevelEncryptionProfile) Servable() bool { return p != nil && len(p.Refusals) == 0 }

// EncryptionEntity is one EncryptionEntities entry: a public key, a provider
// name and the field name patterns it encrypts.
type EncryptionEntity struct {
	PublicKeyID   string   `json:"publicKeyId"`
	ProviderID    string   `json:"providerId"`
	FieldPatterns []string `json:"fieldPatterns,omitempty"`
}

const propertyFieldLevelEncryptionProfile = "FieldLevelEncryptionProfileConfig"

func parseFieldLevelEncryptionConfig(stack, id string, resource Resource, index *resourceIndex) (*FieldLevelEncryptionConfig, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	config := &FieldLevelEncryptionConfig{LogicalID: index.qualified(stack, id), Stack: stack}
	// AWS::CloudFront::FieldLevelEncryptionConfig carries CallerReference,
	// Comment, ContentTypeProfileConfig and QueryArgProfileConfig directly.
	fields := properties
	for _, name := range sortedKeys(fields) {
		switch name {
		case propertyCallerReference:
			config.Reported = append(config.Reported, reportProperty("field-level encryption config", name))
		case propertyComment:
			if err := json.Unmarshal(fields[name], &config.Comment); err != nil {
				return nil, fmt.Errorf("%s/%s: Comment: %w", stack, id, err)
			}
			config.Reported = append(config.Reported, reportProperty("field-level encryption config", name))
		case "ContentTypeProfileConfig":
			parsed, problem := parseContentTypeProfileConfig(fields[name], stack, index)
			if problem != "" {
				config.Refusals = append(config.Refusals, problem)
				continue
			}
			config.ContentTypeProfileConfig = parsed
		case "QueryArgProfileConfig":
			parsed, problem := parseQueryArgProfileConfig(fields[name], stack, index)
			if problem != "" {
				config.Refusals = append(config.Refusals, problem)
				continue
			}
			config.QueryArgProfileConfig = parsed
		default:
			config.Refusals = append(config.Refusals, fmt.Sprintf("property %q is not understood", name))
		}
	}
	if config.ContentTypeProfileConfig == nil {
		config.Refusals = append(config.Refusals, "ContentTypeProfileConfig is missing")
	}
	return config, nil
}

func parseContentTypeProfileConfig(raw json.RawMessage, stack string, index *resourceIndex) (*ContentTypeProfileConfig, string) {
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, "ContentTypeProfileConfig is not an object"
	}
	config := &ContentTypeProfileConfig{}
	for _, name := range sortedKeys(fields) {
		switch name {
		case "ForwardWhenContentTypeIsUnknown":
			if err := json.Unmarshal(fields[name], &config.ForwardWhenContentTypeIsUnknown); err != nil {
				return nil, "ForwardWhenContentTypeIsUnknown is not a boolean"
			}
		case "ContentTypeProfiles":
			profiles, problem := parseContentTypeProfiles(fields[name], stack, index)
			if problem != "" {
				return nil, problem
			}
			config.Profiles = profiles
		default:
			return nil, fmt.Sprintf("ContentTypeProfileConfig property %q is not understood", name)
		}
	}
	return config, ""
}

func parseContentTypeProfiles(raw json.RawMessage, stack string, index *resourceIndex) ([]ContentTypeProfile, string) {
	values, problem := unwrapItems(raw, "ContentTypeProfiles")
	if problem != "" {
		return nil, problem
	}
	out := make([]ContentTypeProfile, 0, len(values))
	for position, value := range values {
		fields, err := decodeObject(value)
		if err != nil {
			return nil, fmt.Sprintf("ContentTypeProfiles[%d] is not an object", position)
		}
		profile := ContentTypeProfile{}
		for _, name := range sortedKeys(fields) {
			switch name {
			case "ContentType":
				if err := json.Unmarshal(fields[name], &profile.ContentType); err != nil {
					return nil, "ContentType is not a string"
				}
			case "Format":
				if err := json.Unmarshal(fields[name], &profile.Format); err != nil {
					return nil, "Format is not a string"
				}
			case "ProfileId":
				qualified, ok := resolveResourceRef(fields[name], stack, index)
				if !ok {
					return nil, fmt.Sprintf("ContentTypeProfiles[%d].ProfileId does not reference an AWS::CloudFront::FieldLevelEncryptionProfile in this assembly", position)
				}
				profile.ProfileID = qualified
			default:
				return nil, fmt.Sprintf("ContentTypeProfiles[%d] property %q is not understood", position, name)
			}
		}
		if profile.ContentType != formContentType {
			return nil, fmt.Sprintf(
				"ContentTypeProfiles[%d].ContentType %q is not %s; CloudFront supports only that content type",
				position, profile.ContentType, formContentType)
		}
		if !strings.EqualFold(profile.Format, "URLEncoded") {
			return nil, fmt.Sprintf("ContentTypeProfiles[%d].Format %q is not URLEncoded", position, profile.Format)
		}
		if profile.ProfileID == "" {
			return nil, fmt.Sprintf("ContentTypeProfiles[%d] has no ProfileId", position)
		}
		out = append(out, profile)
	}
	return out, ""
}

//nolint:gocognit // one branch per configuration field
func parseQueryArgProfileConfig(raw json.RawMessage, stack string, index *resourceIndex) (*QueryArgProfileConfig, string) {
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, "QueryArgProfileConfig is not an object"
	}
	config := &QueryArgProfileConfig{}
	for _, name := range sortedKeys(fields) {
		switch name {
		case "ForwardWhenQueryArgProfileIsUnknown":
			if err := json.Unmarshal(fields[name], &config.ForwardWhenQueryArgProfileIsUnknown); err != nil {
				return nil, "ForwardWhenQueryArgProfileIsUnknown is not a boolean"
			}
		case "QueryArgProfiles":
			values, problem := unwrapItems(fields[name], "QueryArgProfiles")
			if problem != "" {
				return nil, problem
			}
			for position, value := range values {
				entry, err := decodeObject(value)
				if err != nil {
					return nil, fmt.Sprintf("QueryArgProfiles[%d] is not an object", position)
				}
				profile := QueryArgProfile{}
				for _, key := range sortedKeys(entry) {
					switch key {
					case "QueryArg":
						if err := json.Unmarshal(entry[key], &profile.QueryArg); err != nil {
							return nil, "QueryArg is not a string"
						}
					case "ProfileId":
						qualified, ok := resolveResourceRef(entry[key], stack, index)
						if !ok {
							return nil, fmt.Sprintf("QueryArgProfiles[%d].ProfileId does not reference an AWS::CloudFront::FieldLevelEncryptionProfile in this assembly", position)
						}
						profile.ProfileID = qualified
					default:
						return nil, fmt.Sprintf("QueryArgProfiles[%d] property %q is not understood", position, key)
					}
				}
				config.Profiles = append(config.Profiles, profile)
			}
		default:
			return nil, fmt.Sprintf("QueryArgProfileConfig property %q is not understood", name)
		}
	}
	if len(config.Profiles) > 5 {
		return nil, fmt.Sprintf("QueryArgProfiles names %d entries; CloudFront allows five", len(config.Profiles))
	}
	return config, ""
}

func unwrapItems(raw json.RawMessage, context string) ([]json.RawMessage, string) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err == nil {
		return values, ""
	}
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, context + " is not a list"
	}
	items, ok := fields[propertyItems]
	if !ok {
		return nil, context + " has no Items"
	}
	if err := json.Unmarshal(items, &values); err != nil {
		return nil, context + ".Items is not a list"
	}
	return values, ""
}

func parseFieldLevelEncryptionProfile(stack, id string, resource Resource, index *resourceIndex) (*FieldLevelEncryptionProfile, error) {
	properties, err := decodeProperties(resource)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: %w", stack, id, err)
	}
	profile := &FieldLevelEncryptionProfile{LogicalID: index.qualified(stack, id), Stack: stack}
	raw, ok := properties[propertyFieldLevelEncryptionProfile]
	if !ok {
		profile.Refusals = append(profile.Refusals, propertyFieldLevelEncryptionProfile+" is missing")
		return profile, nil
	}
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%s/%s: FieldLevelEncryptionProfileConfig: %w", stack, id, err)
	}
	for _, name := range sortedKeys(fields) {
		switch name {
		case propertyCallerReference:
			profile.Reported = append(profile.Reported, reportProperty("field-level encryption profile", name))
		case propertyComment:
			if err := json.Unmarshal(fields[name], &profile.Comment); err != nil {
				return nil, fmt.Errorf("%s/%s: Comment: %w", stack, id, err)
			}
			profile.Reported = append(profile.Reported, reportProperty("field-level encryption profile", name))
		case "EncryptionEntities":
			entities, problem := parseEncryptionEntities(fields[name], stack, index)
			if problem != "" {
				profile.Refusals = append(profile.Refusals, problem)
				continue
			}
			profile.Entities = entities
		case propertyName:
			if err := json.Unmarshal(fields[name], &profile.Name); err != nil {
				return nil, fmt.Errorf("%s/%s: Name: %w", stack, id, err)
			}
			profile.Reported = append(profile.Reported, reportProperty("field-level encryption profile", name))
		default:
			profile.Refusals = append(profile.Refusals, fmt.Sprintf("property %q is not understood", name))
		}
	}
	if len(profile.Entities) == 0 {
		profile.Refusals = append(profile.Refusals, "EncryptionEntities is empty")
	}
	validateFieldPatterns(profile)
	return profile, nil
}

//nolint:gocognit // one branch per entity field
func parseEncryptionEntities(raw json.RawMessage, stack string, index *resourceIndex) ([]EncryptionEntity, string) {
	values, problem := unwrapItems(raw, "EncryptionEntities")
	if problem != "" {
		return nil, problem
	}
	out := make([]EncryptionEntity, 0, len(values))
	for position, value := range values {
		fields, err := decodeObject(value)
		if err != nil {
			return nil, fmt.Sprintf("EncryptionEntities[%d] is not an object", position)
		}
		entity := EncryptionEntity{}
		for _, name := range sortedKeys(fields) {
			switch name {
			case "PublicKeyId":
				qualified, ok := resolveResourceRef(fields[name], stack, index)
				if !ok {
					return nil, fmt.Sprintf("EncryptionEntities[%d].PublicKeyId does not reference an AWS::CloudFront::PublicKey in this assembly", position)
				}
				entity.PublicKeyID = qualified
			case "ProviderId":
				if err := json.Unmarshal(fields[name], &entity.ProviderID); err != nil {
					return nil, "ProviderId is not a string"
				}
			case "FieldPatterns":
				patterns, problem := unwrapItems(fields[name], "FieldPatterns")
				if problem != "" {
					return nil, problem
				}
				for _, pattern := range patterns {
					var text string
					if err := json.Unmarshal(pattern, &text); err != nil {
						return nil, "FieldPatterns entry is not a string"
					}
					entity.FieldPatterns = append(entity.FieldPatterns, text)
				}
			default:
				return nil, fmt.Sprintf("EncryptionEntities[%d] property %q is not understood", position, name)
			}
		}
		if entity.PublicKeyID == "" {
			return nil, fmt.Sprintf("EncryptionEntities[%d] has no PublicKeyId", position)
		}
		if entity.ProviderID == "" {
			return nil, fmt.Sprintf("EncryptionEntities[%d] has no ProviderId", position)
		}
		out = append(out, entity)
	}
	return out, ""
}

// validateFieldPatterns enforces the documented pattern rules: only
// alphanumerics, square brackets, periods, underscores, hyphens and an optional
// trailing wildcard; at most 10 fields; and no overlapping patterns.
func validateFieldPatterns(profile *FieldLevelEncryptionProfile) {
	total := 0
	var patterns []string
	for _, entity := range profile.Entities {
		total += len(entity.FieldPatterns)
		for _, pattern := range entity.FieldPatterns {
			if pattern == "" {
				profile.Refusals = append(profile.Refusals, "a FieldPatterns entry is empty")
				continue
			}
			if !validFieldPattern(pattern) {
				profile.Refusals = append(profile.Refusals, fmt.Sprintf(
					"FieldPatterns entry %q uses characters CloudFront does not allow (alphanumerics, [ ], ., _, - and a trailing *)", pattern))
				continue
			}
			patterns = append(patterns, pattern)
		}
	}
	if total > 10 {
		profile.Refusals = append(profile.Refusals, fmt.Sprintf(
			"the profile declares %d field patterns; CloudFront encrypts up to 10 data fields in a request", total))
	}
	for i := 0; i < len(patterns); i++ {
		for j := i + 1; j < len(patterns); j++ {
			if fieldPatternsOverlap(patterns[i], patterns[j]) {
				profile.Refusals = append(profile.Refusals, fmt.Sprintf(
					"FieldPatterns %q and %q overlap; CloudFront does not allow overlapping patterns", patterns[i], patterns[j]))
			}
		}
	}
}

func validFieldPattern(pattern string) bool {
	body := strings.TrimSuffix(pattern, "*")
	if body == "" {
		return false
	}
	for _, r := range body {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '[', r == ']', r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// fieldPatternsOverlap reports whether one pattern is a prefix of the other, the
// overlap the page forbids ("if you have a field name pattern of ABC*, you
// can't add another field name pattern that is AB*").
func fieldPatternsOverlap(a, b string) bool {
	aPrefix := strings.TrimSuffix(a, "*")
	bPrefix := strings.TrimSuffix(b, "*")
	return strings.HasPrefix(aPrefix, bPrefix) || strings.HasPrefix(bPrefix, aPrefix)
}

// selectProfile applies the configuration's rules for choosing the profile:
// the content-type profile, overridden by the fle-profile query argument when
// the configuration allows it.
func (c *FieldLevelEncryptionConfig) selectProfile(_, rawQuery string) (string, string) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Sprintf("the query string %q is malformed: %v", rawQuery, err)
	}
	requested := query.Get("fle-profile")
	if requested != "" && c.QueryArgProfileConfig != nil {
		for _, entry := range c.QueryArgProfileConfig.Profiles {
			if entry.QueryArg == requested {
				return entry.ProfileID, ""
			}
		}
		if !c.QueryArgProfileConfig.ForwardWhenQueryArgProfileIsUnknown {
			return "", fmt.Sprintf("fle-profile %q names no profile and the configuration blocks unknown profiles", requested)
		}
	}
	if c.ContentTypeProfileConfig == nil || len(c.ContentTypeProfileConfig.Profiles) == 0 {
		if c.ContentTypeProfileConfig != nil && c.ContentTypeProfileConfig.ForwardWhenContentTypeIsUnknown {
			return "", ""
		}
		return "", fmt.Sprintf("the configuration does not map %s to a profile", formContentType)
	}
	return c.ContentTypeProfileConfig.Profiles[0].ProfileID, ""
}

// encryptFormBody replaces every field that matches the profile's patterns with
// the base64 AWS Encryption SDK ciphertext CloudFront produces.
func encryptFormBody(body []byte, profile *FieldLevelEncryptionProfile, keys map[string]*PublicKey, rng io.Reader) ([]byte, error) {
	if rng == nil {
		rng = rand.Reader
	}
	entities := make([]encryptionTarget, 0, len(profile.Entities))
	for _, entity := range profile.Entities {
		key, ok := keys[entity.PublicKeyID]
		if !ok {
			return nil, fmt.Errorf("public key %s in profile %s is not in the assembly", entity.PublicKeyID, profile.LogicalID)
		}
		rsaKey, ok := key.PublicKey().(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("field-level encryption needs an RSA public key; %s is %T", entity.PublicKeyID, key.PublicKey())
		}
		entities = append(entities, encryptionTarget{
			patterns:   entity.FieldPatterns,
			providerID: entity.ProviderID,
			keyName:    key.Name,
			key:        rsaKey,
		})
	}
	pairs := strings.Split(string(body), "&")
	changed := false
	for position, pair := range pairs {
		if pair == "" {
			continue
		}
		rawName, rawValue, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		name, err := url.QueryUnescape(rawName)
		if err != nil {
			return nil, fmt.Errorf("form field name %q is not URL-encoded: %w", rawName, err)
		}
		value, err := url.QueryUnescape(rawValue)
		if err != nil {
			return nil, fmt.Errorf("form field %q value is not URL-encoded: %w", name, err)
		}
		target, ok := matchEncryptionTarget(entities, name)
		if !ok {
			continue
		}
		ciphertext, err := encryptField([]byte(value), target.key, target.providerID, target.keyName, rng)
		if err != nil {
			return nil, fmt.Errorf("encrypt field %q: %w", name, err)
		}
		// "After encryption, the ciphertext is base64 encoded."
		encoded := base64.StdEncoding.EncodeToString(ciphertext)
		pairs[position] = url.QueryEscape(name) + "=" + url.QueryEscape(encoded)
		changed = true
	}
	if !changed {
		return body, nil
	}
	return []byte(strings.Join(pairs, "&")), nil
}

type encryptionTarget struct {
	patterns   []string
	providerID string
	keyName    string
	key        *rsa.PublicKey
}

func matchEncryptionTarget(targets []encryptionTarget, name string) (encryptionTarget, bool) {
	for _, target := range targets {
		for _, pattern := range target.patterns {
			if fieldPatternMatches(pattern, name) {
				return target, true
			}
		}
	}
	return encryptionTarget{}, false
}

// fieldPatternMatches applies the documented trailing wildcard: "you can type
// the entire name of the data field ... or just the first part of the name with
// a wildcard character (*)". Names are case-sensitive.
func fieldPatternMatches(pattern, name string) bool {
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(name, strings.TrimSuffix(pattern, "*"))
	}
	return pattern == name
}

// The AWS Encryption SDK message CloudFront produces.
//
// CloudFront encrypts each field with the AWS Encryption SDK, and the origin
// decrypts it with a raw RSA master key using PROVIDER_NAME = the profile's
// provider name, KEY_NAME = the public key's name and ALGORITHM
// RSA/ECB/OAEPWithSHA-256AndMGF1Padding.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html
//
// The message layout is the SDK's version 1 non-framed message with algorithm
// suite ALG_AES_256_GCM_IV12_TAG16_HKDF_SHA256 (0x0178):
//
//	header: version(1)=1 type(1)=0x80 suite(2)=0x0178 messageId(16)
//	        AAD length(2)=0 encrypted data keys(2 + entry)
//	        content type(1)=1(no framing) reserved(4)=0 IV length(1)=12 frame length(4)=0
//	header auth: IV(12 zeros) tag(16), AES-GCM over the header as AAD
//	body: IV(12) content length(8) ciphertext tag(16)
//
// The encryption key is HKDF-SHA256(data key, salt = 32 zero bytes,
// info = suite id || message id). The body AAD is
// message id || "AWSKMSEncryptionClient Single Block" || sequence(4) || length(8).
// https://github.com/awslabs/aws-encryption-sdk-specification
const (
	esdkVersion        = 0x01
	esdkTypeCustomerAE = 0x80
	esdkSuiteAES256GCM = 0x0178
	esdkContentTypeRaw = 0x01
	esdkSignatureBlock = "AWSKMSEncryptionClient Single Block"
)

func encryptField(plaintext []byte, key *rsa.PublicKey, providerID, keyName string, rng io.Reader) ([]byte, error) {
	dataKey := make([]byte, 32)
	if _, err := io.ReadFull(rng, dataKey); err != nil {
		return nil, err
	}
	messageID := make([]byte, 16)
	if _, err := io.ReadFull(rng, messageID); err != nil {
		return nil, err
	}
	derived, err := hkdf.Key(sha256.New, dataKey, make([]byte, sha256.Size),
		string(append([]byte{byte(esdkSuiteAES256GCM >> 8), byte(esdkSuiteAES256GCM & 0xff)}, messageID...)), 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	bodyIV := make([]byte, 12)
	binary.BigEndian.PutUint32(bodyIV[8:], 1)
	bodyAAD := make([]byte, 0, 16+len(esdkSignatureBlock)+4+8)
	bodyAAD = append(bodyAAD, messageID...)
	bodyAAD = append(bodyAAD, []byte(esdkSignatureBlock)...)
	bodyAAD = binary.BigEndian.AppendUint32(bodyAAD, 1)
	bodyAAD = binary.BigEndian.AppendUint64(bodyAAD, uint64(len(plaintext)))
	sealedBody := gcm.Seal(nil, bodyIV, plaintext, bodyAAD)
	content := sealedBody[:len(sealedBody)-gcm.Overhead()]
	bodyTag := sealedBody[len(sealedBody)-gcm.Overhead():]

	wrapped, err := rsa.EncryptOAEP(sha256.New(), rng, key, dataKey, nil)
	if err != nil {
		return nil, err
	}
	provider := []byte(providerID)
	info := []byte(keyName)
	header := make([]byte, 0, 4+16+2+2+2+len(provider)+2+len(info)+2+len(wrapped)+1+4+1+4)
	header = append(header, esdkVersion, esdkTypeCustomerAE, byte(esdkSuiteAES256GCM>>8), byte(esdkSuiteAES256GCM&0xff))
	header = append(header, messageID...)
	header = binary.BigEndian.AppendUint16(header, 0)
	header = binary.BigEndian.AppendUint16(header, 1)
	header = binary.BigEndian.AppendUint16(header, uint16(len(provider))) //nolint:gosec // the provider name is at most 128 characters
	header = append(header, provider...)
	header = binary.BigEndian.AppendUint16(header, uint16(len(info))) //nolint:gosec // the key name is at most 128 characters
	header = append(header, info...)
	header = binary.BigEndian.AppendUint16(header, uint16(len(wrapped))) //nolint:gosec // an RSA-2048 ciphertext is 256 bytes
	header = append(header, wrapped...)
	header = append(header, esdkContentTypeRaw)
	header = append(header, 0, 0, 0, 0)
	header = append(header, byte(len(bodyIV))) //nolint:gosec // the IV length is the algorithm suite's 12 bytes
	header = binary.BigEndian.AppendUint32(header, 0)

	headerIV := make([]byte, 12)
	sealedHeader := gcm.Seal(nil, headerIV, nil, header)
	headerTag := sealedHeader[len(sealedHeader)-gcm.Overhead():]

	message := make([]byte, 0, len(header)+12+gcm.Overhead()+len(bodyIV)+8+len(content)+gcm.Overhead())
	message = append(message, header...)
	message = append(message, headerIV...)
	message = append(message, headerTag...)
	message = append(message, bodyIV...)
	message = binary.BigEndian.AppendUint64(message, uint64(len(content)))
	message = append(message, content...)
	message = append(message, bodyTag...)
	return message, nil
}

// flePreconditions reports the HTTPS, method and origin protocol requirements
// as a local deviation: the local viewer is plain HTTP, so the gateway applies
// the behavior and documents the requirement instead of refusing it.
func (d *Distribution) flePreconditions(behavior *Behavior, origin *DistributionOrigin) []string {
	if behavior == nil {
		return nil
	}
	var problems []string
	if behavior.ViewerProtocolPolicy != "redirect-to-https" && behavior.ViewerProtocolPolicy != "https-only" {
		problems = append(problems, fmt.Sprintf(
			"ViewerProtocolPolicy is %q; CloudFront requires redirect-to-https or https-only for field-level encryption", behavior.ViewerProtocolPolicy))
	}
	if !allSevenMethods(behavior.AllowedMethods) {
		problems = append(problems, fmt.Sprintf(
			"AllowedMethods is %s; CloudFront requires GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE for field-level encryption",
			strings.Join(behavior.AllowedMethods, ", ")))
	}
	if origin != nil && origin.Kind == OriginCustom && origin.Custom != nil {
		policy := origin.Custom.ProtocolPolicy
		if policy != "match-viewer" && policy != "https-only" {
			problems = append(problems, fmt.Sprintf(
				"OriginProtocolPolicy is %q; CloudFront requires match-viewer or https-only for field-level encryption", policy))
		}
	}
	return problems
}

func allSevenMethods(methods []string) bool {
	required := []string{"GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"}
	seen := map[string]bool{}
	for _, method := range methods {
		seen[method] = true
	}
	for _, method := range required {
		if !seen[method] {
			return false
		}
	}
	return true
}

// verifyFLEKeys confirms every profile entity names a usable RSA public key.
func verifyFLEKeys(profile *FieldLevelEncryptionProfile, keys map[string]*PublicKey) []string {
	var refusals []string
	for _, entity := range profile.Entities {
		key, ok := keys[entity.PublicKeyID]
		if !ok {
			refusals = append(refusals, fmt.Sprintf("EncryptionEntities PublicKeyId %s is not in the assembly", entity.PublicKeyID))
			continue
		}
		if !key.Servable() {
			refusals = append(refusals, fmt.Sprintf("public key %s is refused: %s", entity.PublicKeyID, strings.Join(key.Refusals, "; ")))
			continue
		}
		if _, ok := key.PublicKey().(*rsa.PublicKey); !ok {
			refusals = append(refusals, fmt.Sprintf("public key %s is not RSA; field-level encryption requires RSA 2048", entity.PublicKeyID))
			continue
		}
		if _, ok := key.PublicKey().(*ecdsa.PublicKey); ok {
			refusals = append(refusals, fmt.Sprintf("public key %s is ECDSA; field-level encryption requires RSA 2048", entity.PublicKeyID))
		}
	}
	return refusals
}

// FieldLevelEncryptionOutcome reports what the edge did with one request body.
type FieldLevelEncryptionOutcome struct {
	// Blocked is a request CloudFront refuses instead of forwarding.
	Blocked bool
	// Status is the status a blocked request returns.
	Status int
	// Reason names why the request was blocked.
	Reason string
	// Applied reports that the body was encrypted.
	Applied bool
}

// applyFieldLevelEncryption encrypts the configured form fields of a POST
// before the request reaches the origin.
//
// The configuration chooses a profile from the content type and lets the
// fle-profile query argument override it when the configuration allows that.
// "When you specify the fle-profile query argument with a profile name that
// doesn't exist for your distribution, you can specify whether CloudFront
// should send the request to the origin without encrypting data fields, or
// block the request and return an error."
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/field-level-encryption.html
//
//nolint:gocyclo // one branch per configuration decision
func (g *Gateway) applyFieldLevelEncryption(
	state *requestState,
	behavior *Behavior,
	request *OriginRequest,
) (FieldLevelEncryptionOutcome, error) {
	if behavior == nil || behavior.FieldLevelEncryptionID == "" {
		return FieldLevelEncryptionOutcome{}, nil
	}
	if state.Method != http.MethodPost {
		return FieldLevelEncryptionOutcome{}, nil
	}
	if g.Topology == nil {
		return FieldLevelEncryptionOutcome{}, fmt.Errorf("field-level encryption needs the topology")
	}
	config, ok := g.Topology.FieldLevelEncryptionConfig(behavior.FieldLevelEncryptionID)
	if !ok {
		return FieldLevelEncryptionOutcome{}, fmt.Errorf(
			"FieldLevelEncryptionId %q is not in the assembly", behavior.FieldLevelEncryptionID)
	}
	if !config.Servable() {
		return FieldLevelEncryptionOutcome{}, fmt.Errorf(
			"field-level encryption configuration %s is refused: %s", config.LogicalID, strings.Join(config.Refusals, "; "))
	}
	contentType := ""
	if value := state.Header.Get("Content-Type"); value != "" {
		parsed, _, err := mime.ParseMediaType(value)
		if err == nil {
			contentType = strings.ToLower(parsed)
		} else {
			contentType = strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
		}
	}
	if contentType != formContentType {
		if config.ContentTypeProfileConfig != nil && config.ContentTypeProfileConfig.ForwardWhenContentTypeIsUnknown {
			return FieldLevelEncryptionOutcome{}, nil
		}
		return FieldLevelEncryptionOutcome{
			Blocked: true,
			Status:  http.StatusBadRequest,
			Reason: fmt.Sprintf(
				"field-level encryption: content type %q is not configured and the configuration blocks unknown content types", contentType),
		}, nil
	}
	profileID, problem := config.selectProfile(state.URI, state.RawQuery)
	if problem != "" {
		return FieldLevelEncryptionOutcome{Blocked: true, Status: http.StatusBadRequest, Reason: problem}, nil
	}
	if profileID == "" {
		return FieldLevelEncryptionOutcome{}, nil
	}
	profile, ok := g.Topology.FieldLevelEncryptionProfile(profileID)
	if !ok {
		return FieldLevelEncryptionOutcome{}, fmt.Errorf("field-level encryption profile %q is not in the assembly", profileID)
	}
	if !profile.Servable() {
		return FieldLevelEncryptionOutcome{}, fmt.Errorf(
			"field-level encryption profile %s is refused: %s", profile.LogicalID, strings.Join(profile.Refusals, "; "))
	}
	keys := map[string]*PublicKey{}
	for _, entity := range profile.Entities {
		if key, found := g.Topology.PublicKey(entity.PublicKeyID); found {
			keys[entity.PublicKeyID] = key
		}
	}
	encrypted, err := encryptFormBody(state.Body, profile, keys, nil)
	if err != nil {
		return FieldLevelEncryptionOutcome{}, err
	}
	state.Body = encrypted
	request.Body = encrypted
	return FieldLevelEncryptionOutcome{Applied: true}, nil
}

// profileIDs returns every profile the configuration can select.
func (c *FieldLevelEncryptionConfig) profileIDs() []string {
	if c == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	if c.ContentTypeProfileConfig != nil {
		for _, profile := range c.ContentTypeProfileConfig.Profiles {
			if profile.ProfileID != "" && !seen[profile.ProfileID] {
				seen[profile.ProfileID] = true
				out = append(out, profile.ProfileID)
			}
		}
	}
	if c.QueryArgProfileConfig != nil {
		for _, profile := range c.QueryArgProfileConfig.Profiles {
			if profile.ProfileID != "" && !seen[profile.ProfileID] {
				seen[profile.ProfileID] = true
				out = append(out, profile.ProfileID)
			}
		}
	}
	return out
}
