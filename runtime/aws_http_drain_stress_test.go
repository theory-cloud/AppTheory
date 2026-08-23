//go:build stress

package apptheory

// This file holds the high-iteration stress reproduction of the
// empty-EOF-at-deadline race in drainBodyReaderForAPIGatewayV2 (the residual
// defect found during the PR #956 parity pass). It is excluded from the default
// `make test` run by the `stress` build tag. Run it with:
//
//	go test -tags stress -run TestDrainBodyReaderForAPIGatewayV2_DeadlineRaceStress -count=1 ./runtime/
//
// The standalone pre-fix reproduction (io.Pipe + writer closing on ctx.Done +
// context.WithTimeout(base, apigatewayV2StreamingBodyTimeout), where base
// carries a 2ms deadline so the drain deadline coincides with the base expiry)
// produced 71 silent empties in 1,279,992 iterations (0.0055%) against the
// ctx.Err()-only guard. With the guard fixed to also compare the wall clock
// against the drain context's own deadline (deadlineReachedByWallClock), this
// test asserts ZERO silent empties: every iteration must fail closed, because
// the pipe only closes when the base context fires, which is exactly the drain
// context's deadline. (A first fix attempt that compared the wall clock against
// the 5s budget instead of the drain context's actual deadline was empirically
// falsified by this test: 368 silent empties in 1,280,000 iterations, because
// the parent's earlier 2ms deadline, not the budget, is the context's real
// expiry.)

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDrainBodyReaderForAPIGatewayV2_DeadlineRaceStress(t *testing.T) {
	if testing.Short() {
		t.Skip("stress reproduction skipped in -short mode")
	}

	const workers = 64
	const perWorker = 20000
	const total = workers * perWorker

	var wg sync.WaitGroup
	var failClosed, silentEmpty, harnessErrs int64

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				pr, pw := io.Pipe()
				base, cancel := context.WithTimeout(context.Background(), 2*time.Millisecond)
				go func() {
					<-base.Done()
					if err := pw.Close(); err != nil {
						// io.Pipe Close only errors on a double close; any
						// error here is a harness defect, not a drain outcome.
						atomic.AddInt64(&harnessErrs, 1)
					}
				}()
				// Mirror drainStreamingBodyForAPIGatewayV2 exactly: the base
				// deadline (2ms) is earlier than the 5s budget, so the drain
				// context's deadline coincides with the base expiry — the
				// condition under which the parent-cancel propagation window
				// was observed.
				drainCtx, dcancel := context.WithTimeout(base, apigatewayV2StreamingBodyTimeout)
				body, err := drainBodyReaderForAPIGatewayV2(drainCtx, pr)
				dcancel()
				cancel()
				if err != nil {
					atomic.AddInt64(&failClosed, 1)
				} else if len(body) == 0 {
					atomic.AddInt64(&silentEmpty, 1)
				}
			}
		}()
	}
	wg.Wait()

	if harnessErrs != 0 {
		t.Fatalf("harness pipe-close errors: %d", harnessErrs)
	}
	if silentEmpty != 0 {
		t.Fatalf("silent empty 200s: %d of %d iterations — the empty-EOF-at-deadline guard must fail closed on every boundary iteration", silentEmpty, total)
	}
	if failClosed != total {
		t.Fatalf("expected every iteration to fail closed, got failClosed=%d silentEmpty=%d of %d", failClosed, silentEmpty, total)
	}
	t.Logf("stress pass: %d boundary iterations, %d fail-closed, 0 silent empties", total, failClosed)
}
