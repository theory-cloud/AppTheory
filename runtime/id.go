package apptheory

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"sync/atomic"
	"time"
)

// IDGenerator provides randomness for IDs/correlation IDs.
type IDGenerator interface {
	NewID() string
}

// IdGenerator is an alias for IDGenerator (cross-language naming parity).
type IdGenerator = IDGenerator

// RandomIDGenerator generates IDs using cryptographic randomness.
type RandomIDGenerator struct{}

// RandomIdGenerator is an alias for RandomIDGenerator (cross-language naming parity).
type RandomIdGenerator = RandomIDGenerator

var fallbackIDCounter uint64

func (RandomIDGenerator) NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Extremely rare; fall back to time + counter so IDs remain unique.
		nano := time.Now().UnixNano()
		if nano < 0 {
			nano = 0
		}
		//nolint:gosec // nano is clamped to non-negative before conversion.
		binary.LittleEndian.PutUint64(b[0:8], uint64(nano))
		binary.LittleEndian.PutUint64(b[8:16], atomic.AddUint64(&fallbackIDCounter, 1))
	}
	return hex.EncodeToString(b[:])
}
