package apptheorycdk

// Keeper's answer to a reader request.
type AppTheoryKeeperAnswer string

const (
	// The source is shared and the read returned events.
	AppTheoryKeeperAnswer_EVENTS AppTheoryKeeperAnswer = "EVENTS"
	// The source is shared and the read returned no events.
	AppTheoryKeeperAnswer_ALLOWED_NO_EVENTS AppTheoryKeeperAnswer = "ALLOWED_NO_EVENTS"
	// The source is not shared, or the read failed closed.
	AppTheoryKeeperAnswer_NOT_SHARED AppTheoryKeeperAnswer = "NOT_SHARED"
)
