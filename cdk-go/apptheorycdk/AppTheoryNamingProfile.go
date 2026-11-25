package apptheorycdk

// Naming profiles accepted by a naming context.
type AppTheoryNamingProfile string

const (
	// Names derive from the naming context.
	AppTheoryNamingProfile_DERIVED AppTheoryNamingProfile = "DERIVED"
	// Every name comes from a pin.
	AppTheoryNamingProfile_LEGACY AppTheoryNamingProfile = "LEGACY"
)
