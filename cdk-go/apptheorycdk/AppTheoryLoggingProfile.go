package apptheorycdk

// Logging profiles accepted by a naming context.
type AppTheoryLoggingProfile string

const (
	// AppTheory creates standard log groups and access logging.
	AppTheoryLoggingProfile_STANDARD AppTheoryLoggingProfile = "STANDARD"
	// Each construct keeps its pre-contract logging behaviour.
	AppTheoryLoggingProfile_LEGACY AppTheoryLoggingProfile = "LEGACY"
)
