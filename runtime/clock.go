package apptheory

import "time"

// Clock provides deterministic time for handlers and middleware.
type Clock interface {
	Now() time.Time
}

// RealClock uses time.Now.
type RealClock struct{}

func (RealClock) Now() time.Time {
	return time.Now()
}
