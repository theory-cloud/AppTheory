package apptheory

import (
	"crypto/rand"
	"encoding/hex"
)

// IDGenerator provides randomness for IDs/correlation IDs.
type IDGenerator interface {
	NewID() string
}

// RandomIDGenerator generates IDs using cryptographic randomness.
type RandomIDGenerator struct{}

func (RandomIDGenerator) NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

