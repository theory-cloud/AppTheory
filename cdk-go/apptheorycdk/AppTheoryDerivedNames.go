package apptheorycdk

// The derived-name artifact a naming context emits at synthesis (contract section 11.4), keyed `{stack}.metadata.json` in the cloud assembly.
type AppTheoryDerivedNames struct {
	// The naming context that produced the artifact.
	Context *AppTheoryNamingContextValues `field:"required" json:"context" yaml:"context"`
	// The contract identifier.
	Contract *string `field:"required" json:"contract" yaml:"contract"`
	// Every physically named resource the context declares, sorted by `scope`, `type`, `name` and `logicalId`.
	Entries *[]*AppTheoryDerivedName `field:"required" json:"entries" yaml:"entries"`
	// The artifact schema identifier.
	Schema *string `field:"required" json:"schema" yaml:"schema"`
}
