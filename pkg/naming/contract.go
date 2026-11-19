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
	"log_delivery_source":      {Kind: "dash", Max: 60, Charset: `[A-Za-z0-9_-]`},
	"log_delivery_destination": {Kind: "dash", Max: 60, Charset: `[A-Za-z0-9_-]`},
	"log_group":                {Kind: "log", Max: 512, Charset: `[A-Za-z0-9_-]`},
}

// ComposedName is the result of composing a logical name.
type ComposedName struct {
	Name             string `json:"name"`
	BucketNamePrefix string `json:"bucket_name_prefix,omitempty"`
	BucketNamespace  string `json:"bucket_namespace,omitempty"`
	Pinned           bool   `json:"pinned,omitempty"`
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
	namespace := ctx.Namespace
	if namespace == "" {
		namespace = LogPrefix
	}
	if !namespaceRe.MatchString(namespace) {
		return errors.New("namespace")
	}
	return nil
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
	namespace := ctx.Namespace
	if namespace == "" {
		namespace = LogPrefix
	}
	return strings.Join([]string{LogPrefix, namespace, ctx.App, ctx.Stage}, "_") + "_"
}

// LogGroupName maps a logical log source to its physical log-group name.
func LogGroupName(ctx Context, logical string) (string, error) {
	if !strings.HasPrefix(logical, "logs/") {
		return "", errors.New("log logical must start with logs/")
	}
	return LogSourcePrefix(ctx) + strings.ReplaceAll(logical, "/", "_"), nil
}

// PhysicalName composes the physical name of one resource. Pins are keyed
// "{type}:{logical}" and, when present, are returned verbatim.
func PhysicalName(ctx Context, resourceType, logical string, pins map[string]string) (ComposedName, error) {
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
	if pin, ok := pins[resourceType+":"+logical]; ok {
		return ComposedName{Name: pin, Pinned: true}, nil
	}
	profile := ctx.NamingProfile
	if profile == "" {
		profile = NamingProfileDerived
	}
	if profile == NamingProfileLegacy {
		return ComposedName{}, errors.New("legacy naming profile requires a pin for every resource")
	}

	out, err := composeName(ctx, resourceType, logical, rule)
	if err != nil {
		return ComposedName{}, err
	}

	if !regexp.MustCompile(rule.Charset + "+").MatchString(out.Name) {
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

func composeName(ctx Context, resourceType, logical string, rule ResourceRule) (ComposedName, error) {
	switch rule.Kind {
	case "s3ar":
		suffix := S3AccountRegionalSuffix(ctx)
		budget := rule.Max - len(suffix)
		prefix := ShortenName(ctx.App+"-"+ctx.Stage+"-"+strings.ReplaceAll(logical, "/", "-"), budget)
		return ComposedName{
			Name:             prefix + suffix,
			BucketNamePrefix: prefix,
			BucketNamespace:  "account-regional",
		}, nil
	case "dash":
		return ComposedName{Name: ShortenName(ctx.App+"-"+ctx.Stage+"-"+strings.ReplaceAll(logical, "/", "-"), rule.Max)}, nil
	case "path":
		full := rule.Lead + ctx.App + "/" + ctx.Stage + "/" + logical
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

func sortedCopy(values []string) []string {
	out := append([]string(nil), values...)
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
	include := sortedCopy(rules.Include)
	exclude := sortedCopy(rules.Exclude)
	if include == nil {
		include = []string{}
	}
	if exclude == nil {
		exclude = []string{}
	}
	return fmt.Sprintf(`{"exclude":%s,"include":%s}`, compactJSON(exclude), compactJSON(include))
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
	for _, sel := range sortedCopy(rules.Include) {
		included = append(included, SelectorARNs(ctx, sel)...)
	}
	for _, sel := range sortedCopy(rules.Exclude) {
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
	include := sortedCopy(rules.Include)
	exclude := sortedCopy(rules.Exclude)
	if include == nil {
		include = []string{}
	}
	if exclude == nil {
		exclude = []string{}
	}
	return FutureRules{Include: include, Exclude: exclude}
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
