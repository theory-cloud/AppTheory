package apptheorycdk

// The naming scopes of contract section 11.1.
type AppTheoryNamingScope string

const (
	// AWS keeps the name unique across the whole account, whatever the Region.
	AppTheoryNamingScope_ACCOUNT AppTheoryNamingScope = "ACCOUNT"
	// AWS keeps the name unique per account and Region.
	AppTheoryNamingScope_ACCOUNT_REGION AppTheoryNamingScope = "ACCOUNT_REGION"
	// AWS does not keep the name unique, so nothing is reserved for it.
	AppTheoryNamingScope_NOT_UNIQUE AppTheoryNamingScope = "NOT_UNIQUE"
)
