package apptheorycdk

// Traffic shifting mode for AppTheory-managed Lambda aliases.
type AppTheoryLambdaTrafficShiftType string

const (
	// Shift all traffic to the new version at once.
	AppTheoryLambdaTrafficShiftType_ALL_AT_ONCE AppTheoryLambdaTrafficShiftType = "ALL_AT_ONCE"
	// Shift one canary increment, wait, then shift the remaining traffic.
	AppTheoryLambdaTrafficShiftType_CANARY AppTheoryLambdaTrafficShiftType = "CANARY"
	// Shift traffic in equal linear increments.
	AppTheoryLambdaTrafficShiftType_LINEAR AppTheoryLambdaTrafficShiftType = "LINEAR"
)
