package apptheorycdk

// The synth-time visibility preview.
type AppTheoryVisibilityPreview struct {
	// The selectors, as the statement of what future sources will match.
	Future *AppTheoryVisibilityRules `field:"required" json:"future" yaml:"future"`
	// Current synthesized sources the rules share.
	MatchedNow *[]*string `field:"required" json:"matchedNow" yaml:"matchedNow"`
	// Current synthesized sources the rules do not share.
	NotMatchedNow *[]*string `field:"required" json:"notMatchedNow" yaml:"notMatchedNow"`
	// First 12 hex characters of the canonical rules hash.
	RuleVersion *string `field:"required" json:"ruleVersion" yaml:"ruleVersion"`
}
