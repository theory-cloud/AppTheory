package naming

import (
	"crypto/sha256"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Contract is the resource-naming contract this package implements.
const Contract = "theorycloud_resource_naming.v0.1"

// LogPrefix is the leading segment of every log-source name.
const LogPrefix = "theorycloud"

// Naming profile values accepted by Context.NamingProfile.
const (
	NamingProfileDerived = "derived"
	NamingProfileLegacy  = "legacy"
)

// RolePolicyMax is the aggregate inline role policy quota, in characters.
const RolePolicyMax = 10240

// HostedNamespaceMax is the longest hosted namespace label, in characters
// (contract section 1, r5 rev1).
const HostedNamespaceMax = 12

const (
	segmentPattern = `[a-z0-9]+(?:-[a-z0-9]+)*`
	stripSet       = "-_./"
)

var (
	logicalRe   = regexp.MustCompile(`^` + segmentPattern + `(?:/` + segmentPattern + `)*$`)
	appRe       = regexp.MustCompile(`^` + segmentPattern + `$`)
	stageRe     = regexp.MustCompile(`^[a-z][a-z0-9]{0,7}$`)
	namespaceRe = regexp.MustCompile(`^` + segmentPattern + `$`)
	accountRe   = regexp.MustCompile(`^[0-9]{12}$`)
	regionRe    = regexp.MustCompile(`^[a-z]{2}(?:-[a-z]+)+-[0-9]$`)
	secretTail  = regexp.MustCompile(`-[A-Za-z0-9]{6}$`)
	s3EdgesRe   = regexp.MustCompile(`^[a-z0-9].*[a-z0-9]$`)
)

// Context is the bound naming context (contract section 1). It comes from stage
// config, never from the environment.
type Context struct {
	Namespace     string `json:"namespace,omitempty"`
	App           string `json:"app"`
	Stage         string `json:"stage"`
	Account       string `json:"account"`
	Region        string `json:"region"`
	NamingProfile string `json:"naming_profile,omitempty"`

	// Hosted marks a deployment TheoryCloud.ai places on a tenant's behalf
	// (contract section 1, r5). A hosted deployment always supplies its
	// namespace, never uses the reserved platform namespace, and carries the
	// namespace in every derived name (contract section 2). Only first-party
	// platform apps omit it.
	Hosted bool `json:"hosted,omitempty"`

	// namespaceExplicit records that a decoded context carried the namespace
	// key. The contract defaults an absent namespace to LogPrefix but rejects an
	// explicit empty one, and Go's empty string alone cannot tell the two apart.
	namespaceExplicit bool
}

// UnmarshalJSON decodes a context and records whether the namespace key was present.
func (c *Context) UnmarshalJSON(data []byte) error {
	type plain Context
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil {
		return err
	}
	*c = Context(decoded)
	_, c.namespaceExplicit = keys["namespace"]
	return nil
}

// ResourceRule describes one row of the composition table (contract section 2).
type ResourceRule struct {
	Kind    string // dash | path | s3ar | log
	Max     int
	Charset string
	Lead    string
}

// ResourceRules is the per-type composition table.
var ResourceRules = map[string]ResourceRule{
	"s3_bucket":                {Kind: "s3ar", Max: 63, Charset: `[a-z0-9-]`},
	"s3_vector_bucket":         {Kind: "dash", Max: 63, Charset: `[a-z0-9-]`},
	"s3_vector_index":          {Kind: "dash", Max: 63, Charset: `[a-z0-9-]`},
	"dynamodb_table":           {Kind: "dash", Max: 255, Charset: `[A-Za-z0-9_.-]`},
	"lambda_function":          {Kind: "dash", Max: 64, Charset: `[A-Za-z0-9_-]`},
	"sqs_queue":                {Kind: "dash", Max: 80, Charset: `[A-Za-z0-9_-]`},
	"sns_topic":                {Kind: "dash", Max: 256, Charset: `[A-Za-z0-9_-]`},
	"secret":                   {Kind: "path", Max: 512, Charset: `[A-Za-z0-9/_+=.@-]`},
	"ssm_parameter":            {Kind: "path", Max: 900, Charset: `[A-Za-z0-9_./-]`, Lead: "/"},
	"kms_alias":                {Kind: "path", Max: 256, Charset: `[A-Za-z0-9/_-]`, Lead: "alias/"},
	"event_bus":                {Kind: "dash", Max: 256, Charset: `[A-Za-z0-9._-]`},
	"event_rule":               {Kind: "dash", Max: 64, Charset: `[A-Za-z0-9._-]`},
	"schedule":                 {Kind: "dash", Max: 64, Charset: `[A-Za-z0-9._-]`},
	"alarm":                    {Kind: "dash", Max: 255, Charset: `[A-Za-z0-9_.-]`},
	"dashboard":                {Kind: "dash", Max: 255, Charset: `[A-Za-z0-9_-]`},
	"iam_role":                 {Kind: "dash", Max: 64, Charset: `[A-Za-z0-9+=,.@_-]`},
	"iam_managed_policy":       {Kind: "dash", Max: 128, Charset: `[A-Za-z0-9+=,.@_-]`},
	"state_machine":            {Kind: "dash", Max: 80, Charset: `[A-Za-z0-9_-]`},
	"codebuild_project":        {Kind: "dash", Max: 150, Charset: `[A-Za-z0-9_-]`},
	"api_rest":                 {Kind: "dash", Max: 128, Charset: `[A-Za-z0-9_-]`},
	"api_http":                 {Kind: "dash", Max: 128, Charset: `[A-Za-z0-9_-]`},
	"api_websocket":            {Kind: "dash", Max: 128, Charset: `[A-Za-z0-9_-]`},
	"log_delivery_source":      {Kind: "dash", Max: 60, Charset: `[A-Za-z0-9_-]`},
	"log_delivery_destination": {Kind: "dash", Max: 60, Charset: `[A-Za-z0-9_-]`},
	"log_group":                {Kind: "log", Max: 512, Charset: `[A-Za-z0-9_-]`},
}

// apiTypes are the API Gateway name types. The CDK defaults an API Name today,
// so a name for one is explicit and takes a pin, never a generated entry (r3).
var apiTypes = map[string]struct{}{
	"api_rest":      {},
	"api_http":      {},
	"api_websocket": {},
}

func isAPIType(resourceType string) bool {
	_, ok := apiTypes[resourceType]
	return ok
}

// ComposedName is the result of composing a logical name.
type ComposedName struct {
	Name             string `json:"name,omitempty"`
	BucketNamePrefix string `json:"bucket_name_prefix,omitempty"`
	BucketNamespace  string `json:"bucket_namespace,omitempty"`
	Pinned           bool   `json:"pinned,omitempty"`
	// Generated reports that CloudFormation generates the name today, so the
	// construct sets no physical-name property (contract section 4).
	Generated bool `json:"generated,omitempty"`
}

// ValidateContext enforces the bound-context grammar from contract section 1.
func ValidateContext(ctx Context) error {
	if !appRe.MatchString(ctx.App) {
		return errors.New("app")
	}
	if !stageRe.MatchString(ctx.Stage) {
		return errors.New("stage")
	}
	if !accountRe.MatchString(ctx.Account) {
		return errors.New("account")
	}
	if !regionRe.MatchString(ctx.Region) {
		return errors.New("region")
	}
	// r5 rev1: a hosted deployment always supplies its namespace; it never
	// defaults to the platform form.
	if ctx.Hosted && ctx.Namespace == "" {
		return errors.New("a hosted deployment must supply its namespace")
	}
	ns := namespaceOf(ctx)
	if !namespaceRe.MatchString(ns) {
		return errors.New("namespace")
	}
	// r5 rev1: `theorycloud` is reserved for first-party platform apps. A hosted
	// deployment may never use it, because its names would then collide with the
	// platform app's in a pooled account.
	if ctx.Hosted && ns == LogPrefix {
		return errors.New("namespace " + LogPrefix + " is reserved for first-party platform apps")
	}
	return ValidateHostedNamespace(ns)
}

// ValidateHostedNamespace applies the hosted namespace label rule (contract
// section 1, r5 rev1): a namespace other than the reserved platform one is at
// most HostedNamespaceMax characters and never starts with `aws` or `ssm`.
// Those two prefixes are reserved by AWS, so a name carrying them cannot be
// created.
func ValidateHostedNamespace(ns string) error {
	if ns == LogPrefix {
		return nil
	}
	if len(ns) > HostedNamespaceMax {
		return errors.New("hosted namespace longer than 12 characters")
	}
	if strings.HasPrefix(ns, "aws") || strings.HasPrefix(ns, "ssm") {
		return errors.New("hosted namespace must not start with aws or ssm")
	}
	return nil
}

// namespaced reports whether every derived name carries the namespace (contract
// section 2, r5): true for a hosted deployment and for any namespace other than
// the reserved platform one. The platform namespace keeps the compatibility
// form byte for byte, so the live hard gate (contract section 4) is unchanged.
func namespaced(ctx Context) bool {
	return ctx.Hosted || namespaceOf(ctx) != LogPrefix
}

// dashStem is the `{namespace}-{app}-{stage}-{logical}` stem of a `dash` name or
// an S3 account-regional prefix, with `/` in the logical name replaced by `-`.
func dashStem(ctx Context, logical string) string {
	parts := []string{ctx.App, ctx.Stage, strings.ReplaceAll(logical, "/", "-")}
	if namespaced(ctx) {
		parts = append([]string{namespaceOf(ctx)}, parts...)
	}
	return strings.Join(parts, "-")
}

// pathStem is the `{namespace}/{app}/{stage}/{logical}` stem of a `path` name.
func pathStem(ctx Context, logical string) string {
	parts := []string{ctx.App, ctx.Stage, logical}
	if namespaced(ctx) {
		parts = append([]string{namespaceOf(ctx)}, parts...)
	}
	return strings.Join(parts, "/")
}

// hostedPinLead is the leading namespace component a hosted pin must carry,
// exactly where the derived form puts it (contract section 4, r5 rev1, rev2).
// Containing the namespace elsewhere is not enough: `shop-lab-events` is not a
// pin for namespace `hop`.
func hostedPinLead(ctx Context, rule ResourceRule) string {
	ns := namespaceOf(ctx)
	switch rule.Kind {
	case "path":
		return rule.Lead + ns + "/"
	case "log":
		return strings.Join([]string{LogPrefix, ns}, "_") + "_"
	default:
		return ns + "-"
	}
}

// namespaceOf returns the contract namespace, defaulting only when the key was
// absent. An explicit empty namespace is invalid (contract section 1).
func namespaceOf(ctx Context) string {
	if ctx.Namespace == "" && !ctx.namespaceExplicit {
		return LogPrefix
	}
	return ctx.Namespace
}

// ShortenName applies the deterministic over-budget form (contract section 2.2).
func ShortenName(full string, limit int) string {
	if len(full) <= limit {
		return full
	}
	head := strings.TrimRight(full[:limit-9], stripSet)
	return head + "-" + hash8(full)
}

func hash8(text string) string {
	digest := sha256.Sum256([]byte(text))
	return strings.ToLower(base32.StdEncoding.EncodeToString(digest[:]))[:8]
}

// S3AccountRegionalSuffix is the CloudFormation-appended account-regional suffix.
func S3AccountRegionalSuffix(ctx Context) string {
	return fmt.Sprintf("-%s-%s-an", ctx.Account, ctx.Region)
}

// LogSourcePrefix is the bound prefix shared by every log source of the app.
func LogSourcePrefix(ctx Context) string {
	return strings.Join([]string{LogPrefix, namespaceOf(ctx), ctx.App, ctx.Stage}, "_") + "_"
}

// LogGroupName maps a logical log source to its physical log-group name.
func LogGroupName(ctx Context, logical string) (string, error) {
	if !strings.HasPrefix(logical, "logs/") {
		return "", errors.New("log logical must start with logs/")
	}
	return LogSourcePrefix(ctx) + strings.ReplaceAll(logical, "/", "_"), nil
}

// PhysicalName composes the physical name of one resource. Pins are keyed
// "{type}:{logical}" and, when present, are returned verbatim. A generated
// entry keyed the same way means CloudFormation generates the name today, so
// the construct sets no physical-name property and the result is
// {"generated": true}. Generated entries are valid only under the legacy
// naming profile (contract section 4).
//
// A hosted deployment (hosted true, or any namespace other than the platform
// one) carries the namespace as the first component of every derived name, its
// S3 prefix included, and takes no pin or generated entry whose name does not
// start with that namespace component (contract sections 2 and 4, r5).
func PhysicalName(ctx Context, resourceType, logical string, pins map[string]string, generated []string) (ComposedName, error) {
	if err := ValidateContext(ctx); err != nil {
		return ComposedName{}, err
	}
	if !logicalRe.MatchString(logical) {
		return ComposedName{}, errors.New("logical")
	}
	rule, ok := ResourceRules[resourceType]
	if !ok {
		return ComposedName{}, fmt.Errorf("resource type %s", resourceType)
	}
	entry, resolved, err := resolveEntry(ctx, resourceType, logical, rule, pins, generated)
	if err != nil {
		return ComposedName{}, err
	}
	if resolved {
		return entry, nil
	}

	out, err := composeName(ctx, resourceType, logical, rule)
	if err != nil {
		return ComposedName{}, err
	}

	if !matchesCharset(rule.Charset, out.Name) {
		return ComposedName{}, errors.New("charset")
	}
	if len(out.Name) > rule.Max {
		return ComposedName{}, errors.New("length")
	}
	if resourceType == "s3_bucket" || resourceType == "s3_vector_bucket" || resourceType == "s3_vector_index" {
		if !s3EdgesRe.MatchString(out.Name) {
			return ComposedName{}, errors.New("s3 start/end")
		}
	}
	return out, nil
}

// resolveEntry applies the legacy profile's pin and generated rules. The second
// result reports whether an entry supplied the name.
func resolveEntry(ctx Context, resourceType, logical string, rule ResourceRule, pins map[string]string, generated []string) (ComposedName, bool, error) {
	profile := ctx.NamingProfile
	if profile == "" {
		profile = NamingProfileDerived
	}
	legacy := profile == NamingProfileLegacy
	if err := checkEntryProfile(ctx, legacy, generated); err != nil {
		return ComposedName{}, false, err
	}
	key := resourceType + ":" + logical
	pin, hasPin := pins[key]
	keepGenerated := containsString(generated, key)
	// r3, ADV-1312-3: CDK defaults an API Name today, so it is an explicit name
	// and takes a pin, never a generated entry.
	if keepGenerated && isAPIType(resourceType) {
		return ComposedName{}, false, errors.New("an API name takes a pin, never a generated entry")
	}
	if hasPin && keepGenerated {
		return ComposedName{}, false, errors.New("a resource has both a pin and a generated entry")
	}
	if hasPin {
		if err := checkHostedPin(ctx, rule, pin); err != nil {
			return ComposedName{}, false, err
		}
		return ComposedName{Name: pin, Pinned: true}, true, nil
	}
	if keepGenerated {
		return ComposedName{Generated: true}, true, nil
	}
	if legacy {
		return ComposedName{}, false, errors.New("legacy naming profile requires a pin or a generated entry for every resource")
	}
	return ComposedName{}, false, nil
}

// checkEntryProfile applies the naming-profile rules that decide whether a
// stage config may carry entries at all.
//
// r5 rev2: the legacy profile and generated entries are first-party
// live-compatibility tools only. A hosted deployment takes neither, because a
// pinned or CloudFormation-generated name carries no namespace and would collide
// across tenants in a pooled account.
func checkEntryProfile(ctx Context, legacy bool, generated []string) error {
	if namespaced(ctx) && (legacy || len(generated) > 0) {
		return errors.New("a hosted deployment takes no legacy profile or generated entries")
	}
	if len(generated) > 0 && !legacy {
		return errors.New("generated entries are only valid under the legacy naming profile")
	}
	return nil
}

// checkHostedPin applies the hosted pin rule (contract section 4, r5 rev1,
// rev2): a hosted pin starts with its namespace component, exactly where the
// derived form puts it. Containing the namespace elsewhere is not enough.
func checkHostedPin(ctx Context, rule ResourceRule, pin string) error {
	if !namespaced(ctx) {
		return nil
	}
	if strings.HasPrefix(pin, hostedPinLead(ctx, rule)) {
		return nil
	}
	return errors.New("a hosted pin must start with the namespace component")
}

// matchesCharset applies a row's charset to the whole name, anchored like the
// reference implementation's fullmatch.
func matchesCharset(charset, name string) bool {
	return regexp.MustCompile("^(?:" + charset + ")+$").MatchString(name)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func composeName(ctx Context, resourceType, logical string, rule ResourceRule) (ComposedName, error) {
	switch rule.Kind {
	case "s3ar":
		suffix := S3AccountRegionalSuffix(ctx)
		budget := rule.Max - len(suffix)
		prefix := ShortenName(dashStem(ctx, logical), budget)
		return ComposedName{
			Name:             prefix + suffix,
			BucketNamePrefix: prefix,
			BucketNamespace:  "account-regional",
		}, nil
	case "dash":
		return ComposedName{Name: ShortenName(dashStem(ctx, logical), rule.Max)}, nil
	case "path":
		full := rule.Lead + pathStem(ctx, logical)
		if resourceType == "secret" && secretTail.MatchString(full) {
			return ComposedName{}, errors.New("secret name must not end with a hyphen and six characters")
		}
		if resourceType == "ssm_parameter" && strings.Count(full, "/") > 15 {
			return ComposedName{}, errors.New("ssm hierarchy deeper than 15")
		}
		if len(full) > rule.Max {
			return ComposedName{}, errors.New("path name over limit")
		}
		return ComposedName{Name: full}, nil
	case "log":
		name, err := LogGroupName(ctx, logical)
		if err != nil {
			return ComposedName{}, err
		}
		if len(name) > rule.Max {
			return ComposedName{}, errors.New("log group over limit")
		}
		return ComposedName{Name: name}, nil
	default:
		return ComposedName{}, fmt.Errorf("unsupported kind %s", rule.Kind)
	}
}

// ---- visibility (contract sections 5-7) -----------------------------------

// KeeperActions are the only log actions a reader role is granted.
var (
	KeeperActionsGroup  = []string{"logs:FilterLogEvents", "logs:DescribeLogStreams"}
	KeeperActionsStream = []string{"logs:GetLogEvents"}
)

// Rules are a consumer's include/exclude visibility selectors.
type Rules struct {
	Include []string `json:"include,omitempty"`
	Exclude []string `json:"exclude,omitempty"`
}

// Statement is one IAM policy statement.
type Statement struct {
	Sid      string   `json:"Sid"`
	Effect   string   `json:"Effect"`
	Action   []string `json:"Action"`
	Resource []string `json:"Resource"`
}

// Policy is the compiled reader-role inline policy.
type Policy struct {
	Version   string      `json:"Version"`
	Statement []Statement `json:"Statement"`
}

// FutureRules is the selector statement of the preview.
type FutureRules struct {
	Include []string `json:"include"`
	Exclude []string `json:"exclude"`
}

// Preview is the synth-time visibility preview.
type Preview struct {
	RuleVersion   string      `json:"rule_version"`
	MatchedNow    []string    `json:"matched_now"`
	NotMatchedNow []string    `json:"not_matched_now"`
	Future        FutureRules `json:"future"`
}

// Manifest is the published SSM manifest: the preview minus not_matched_now.
type Manifest struct {
	RuleVersion string      `json:"rule_version"`
	MatchedNow  []string    `json:"matched_now"`
	Future      FutureRules `json:"future"`
}

// ValidateSelector enforces the selector grammar (contract section 5).
func ValidateSelector(sel string) error {
	base := sel
	if strings.HasSuffix(sel, "/*") {
		base = sel[:len(sel)-2]
	}
	bareLogs := base == "logs" && !strings.HasSuffix(sel, "/*")
	if !logicalRe.MatchString(base) || strings.Split(base, "/")[0] != "logs" || bareLogs {
		return fmt.Errorf("selector %s", sel)
	}
	if strings.Contains(base, "*") {
		return errors.New("wildcard only as trailing /*")
	}
	return nil
}

// SelectorMatches reports whether a selector matches a logical source. A trailing
// "/*" matches descendants only, never the prefix itself.
func SelectorMatches(sel, logical string) bool {
	if strings.HasSuffix(sel, "/*") {
		return strings.HasPrefix(logical, sel[:len(sel)-1])
	}
	return logical == sel
}

// Visible reports whether a source is visible: an include matches and no exclude
// does. Exclusions win.
func Visible(rules Rules, logical string) bool {
	include := false
	for _, sel := range rules.Include {
		if SelectorMatches(sel, logical) {
			include = true
			break
		}
	}
	if !include {
		return false
	}
	for _, sel := range rules.Exclude {
		if SelectorMatches(sel, logical) {
			return false
		}
	}
	return true
}

// SelectorARNs expands a selector to the log-group ARNs it covers.
func SelectorARNs(ctx Context, sel string) []string {
	base := fmt.Sprintf("arn:aws:logs:%s:%s:log-group:", ctx.Region, ctx.Account)
	if strings.HasSuffix(sel, "/*") {
		mapped := strings.ReplaceAll(sel[:len(sel)-1], "/", "_")
		return []string{base + LogSourcePrefix(ctx) + mapped + "*"}
	}
	name := LogSourcePrefix(ctx) + strings.ReplaceAll(sel, "/", "_")
	return []string{base + name, base + name + ":*"}
}

// RuleVersion is the first 12 hex characters of SHA-256 over the canonical rules.
func RuleVersion(rules Rules) string {
	canonical := canonicalRules(rules)
	digest := sha256.Sum256([]byte(canonical))
	return fmt.Sprintf("%x", digest)[:12]
}

// uniqueSorted returns the values as a sorted set. Selectors are sets: a
// duplicate include or exclude is ignored in the rule version, the compiled
// policy and the preview (contract section 5).
func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func compactJSON(value any) string {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return strings.TrimSuffix(builder.String(), "\n")
}

func canonicalRules(rules Rules) string {
	return fmt.Sprintf(`{"exclude":%s,"include":%s}`, compactJSON(uniqueSorted(rules.Exclude)), compactJSON(uniqueSorted(rules.Include)))
}

// CompilePolicy compiles the rules into the reader-role inline policy.
func CompilePolicy(ctx Context, rules Rules) (Policy, error) {
	all := append(append([]string(nil), rules.Include...), rules.Exclude...)
	for _, sel := range all {
		if err := ValidateSelector(sel); err != nil {
			return Policy{}, err
		}
	}
	statements := []Statement{{
		Sid:    "ReadManifest",
		Effect: "Allow",
		Action: []string{"ssm:GetParameter"},
		Resource: []string{fmt.Sprintf(
			"arn:aws:ssm:%s:%s:parameter/%s/visibility/%s/%s/manifest",
			ctx.Region, ctx.Account, LogPrefix, ctx.App, ctx.Stage,
		)},
	}}
	actions := append(append([]string(nil), KeeperActionsGroup...), KeeperActionsStream...)
	var included, excluded []string
	for _, sel := range uniqueSorted(rules.Include) {
		included = append(included, SelectorARNs(ctx, sel)...)
	}
	for _, sel := range uniqueSorted(rules.Exclude) {
		excluded = append(excluded, SelectorARNs(ctx, sel)...)
	}
	if len(included) > 0 {
		statements = append(statements, Statement{Sid: "ReadIncluded", Effect: "Allow", Action: actions, Resource: included})
	}
	if len(excluded) > 0 {
		statements = append(statements, Statement{Sid: "DenyExcluded", Effect: "Deny", Action: actions, Resource: excluded})
	}
	policy := Policy{Version: "2012-10-17", Statement: statements}
	if len(compactJSON(policy)) > RolePolicyMax {
		return Policy{}, errors.New("compiled policy over role policy size")
	}
	return policy, nil
}

// PreviewBuild assembles the synth-time preview and validates its selectors.
func PreviewBuild(rules Rules, sources []string) (Preview, error) {
	if err := validateRules(rules); err != nil {
		return Preview{}, err
	}
	matched := []string{}
	notMatched := []string{}
	for _, source := range sources {
		if Visible(rules, source) {
			matched = append(matched, source)
		} else {
			notMatched = append(notMatched, source)
		}
	}
	sort.Strings(matched)
	sort.Strings(notMatched)
	return Preview{
		RuleVersion:   RuleVersion(rules),
		MatchedNow:    matched,
		NotMatchedNow: notMatched,
		Future:        futureRules(rules),
	}, nil
}

// ManifestBuild assembles the published manifest (no not_matched_now).
func ManifestBuild(rules Rules, sources []string) (Manifest, error) {
	preview, err := PreviewBuild(rules, sources)
	if err != nil {
		return Manifest{}, err
	}
	return Manifest{
		RuleVersion: preview.RuleVersion,
		MatchedNow:  preview.MatchedNow,
		Future:      preview.Future,
	}, nil
}

func validateRules(rules Rules) error {
	for _, sel := range append(append([]string(nil), rules.Include...), rules.Exclude...) {
		if err := ValidateSelector(sel); err != nil {
			return err
		}
	}
	return nil
}

func futureRules(rules Rules) FutureRules {
	return FutureRules{Include: uniqueSorted(rules.Include), Exclude: uniqueSorted(rules.Exclude)}
}

// Keeper answers for a reader request (contract section 7).
const (
	KeeperEvents          = "events"
	KeeperAllowedNoEvents = "allowed_no_events"
	KeeperNotShared       = "not_shared"
)

// KeeperDecision answers a read request. A missing manifest, an unmatched source,
// a denied read or an unreachable account all answer not_shared.
func KeeperDecision(rules *Rules, logical, awsResult string) string {
	if rules == nil || !Visible(*rules, logical) {
		return KeeperNotShared
	}
	switch awsResult {
	case "events":
		return KeeperEvents
	case "empty", "not_found":
		return KeeperAllowedNoEvents
	default:
		return KeeperNotShared
	}
}

// Naming scopes (contract section 11.1).
const (
	// ScopeAccount is the scope of names AWS keeps unique across the whole
	// account, whatever the Region.
	ScopeAccount = "account"
	// ScopeAccountRegion is the scope of names AWS keeps unique per account and
	// Region.
	ScopeAccountRegion = "account_region"
	// ScopeNotUnique is the scope of display names AWS does not keep unique, so
	// nothing is reserved for them.
	ScopeNotUnique = "not_unique"
)

// ErrUnknownNamingScope is the refusal for a type the contract states no naming
// scope for. Such a type cannot be reserved, so it cannot be deployed through the
// reservation index until a revision states its scope.
var ErrUnknownNamingScope = errors.New("a type with no stated naming scope cannot be reserved")

// accountGlobalTypes are the types AWS keeps unique across Regions.
var accountGlobalTypes = map[string]struct{}{
	"iam_role":           {},
	"iam_managed_policy": {},
	"dashboard":          {},
}

// notUniqueTypes are the API display names AWS does not keep unique (r4).
var notUniqueTypes = map[string]struct{}{
	"api_rest":      {},
	"api_http":      {},
	"api_websocket": {},
}

// NamingScope returns the scope in which AWS requires a type's names to be
// unique (contract section 11.1). A type the contract states no scope for is
// refused.
func NamingScope(resourceType string) (string, error) {
	if _, ok := ResourceRules[resourceType]; !ok {
		return "", ErrUnknownNamingScope
	}
	if _, ok := notUniqueTypes[resourceType]; ok {
		return ScopeNotUnique, nil
	}
	if _, ok := accountGlobalTypes[resourceType]; ok {
		return ScopeAccount, nil
	}
	return ScopeAccountRegion, nil
}

// NameEntry is one physically named resource a stack declares, as the synth
// check (contract section 11.4) consumes it. A generated entry carries no name:
// CloudFormation owns the name, so there is nothing to reserve.
type NameEntry struct {
	Name      string `json:"name,omitempty"`
	Type      string `json:"type"`
	LogicalID string `json:"logical_id"`
	Generated bool   `json:"generated,omitempty"`
}

// DerivedName is one row of the derived-name artifact: the complete set the
// reservation index (contract section 11.2) reserves.
type DerivedName struct {
	Name      string `json:"name,omitempty"`
	Type      string `json:"type"`
	Scope     string `json:"scope"`
	LogicalID string `json:"logical_id"`
	Generated bool   `json:"generated,omitempty"`
}

// SynthCheck refuses two different logical resources in one naming context that
// derive the same name in the same naming scope, and returns the derived-name
// artifact (contract section 11.4). A Lambda function and its IAM role may share
// a name because their scopes differ, and two APIs may share one because AWS does
// not keep API names unique. Rows keep the order of the entries.
func SynthCheck(entries []NameEntry) ([]DerivedName, error) {
	seen := make(map[string]string, len(entries))
	artifact := make([]DerivedName, 0, len(entries))
	for _, entry := range entries {
		scope, err := NamingScope(entry.Type)
		if err != nil {
			return nil, err
		}
		artifact = append(artifact, DerivedName{
			Name:      entry.Name,
			Type:      entry.Type,
			Scope:     scope,
			LogicalID: entry.LogicalID,
			Generated: entry.Generated,
		})
		if scope == ScopeNotUnique || entry.Generated {
			continue
		}
		key := scope + "\x00" + entry.Type + "\x00" + entry.Name
		if held, ok := seen[key]; ok && held != entry.LogicalID {
			return nil, fmt.Errorf("%s and %s derive %s in scope %s", held, entry.LogicalID, entry.Name, scope)
		}
		seen[key] = entry.LogicalID
	}
	return artifact, nil
}
