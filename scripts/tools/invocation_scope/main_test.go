package main

import (
	"errors"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests prove the guard's three detectors are not vacuous and, more
// importantly, that they are not defeated by the spelling of a join. Every
// "unjoined" case is a launch whose join does not dominate every exit — the
// shapes a presence- or text-based reading accepts by mistake — and every
// "joined" case is a launch a dominating join covers. The probes are the ones
// the AppTheory invocation-scope round-2 sanity review and the TableTheory
// detached-work guard rounds 1-3 used, ported here and extended with the launch
// forms named in this repository's guard contract (aliased imports, walrus
// bindings, aggregates, expression positions, class-field initializers,
// compound and chained assignments).

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

// scanGoSample classifies every Go finding in a sample by the function that
// owns it.
func scanGoSample(t *testing.T, src string) map[string]goLaunchSite {
	t.Helper()

	sites, err := scanGoSource(token.NewFileSet(), "sample.go", []byte(src))
	if err != nil {
		t.Fatalf("parse sample: %v", err)
	}
	byFunc := map[string]goLaunchSite{}
	for _, site := range sites {
		byFunc[site.Func] = site
	}
	return byFunc
}

// TestGoJoinProofRequiresDominance proves the join rules accept every join idiom
// this repository and its siblings use and report each bypass that a mere "a
// Wait appears after the launch" check would wrongly bless.
func TestGoJoinProofRequiresDominance(t *testing.T) {
	const src = `package sample

import (
	"sync"

	"golang.org/x/sync/errgroup"
)

func waitGroupJoin() {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	wg.Wait()
}

func loopLaunchWaitAfter() {
	var wg sync.WaitGroup
	for _, x := range []int{1, 2} {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			_ = v
		}(x)
	}
	wg.Wait()
}

func errgroupJoin() {
	var g errgroup.Group
	g.Go(func() error {
		return nil
	})
	_ = g.Wait()
}

func channelDrainJoin() {
	out := make(chan int)
	go func() {
		defer close(out)
		out <- 1
	}()
	for range out {
	}
}

func closeSignalJoin() {
	done := make(chan struct{})
	go func() {
		defer close(done)
	}()
	select {
	case <-done:
		return
	default:
		<-done
	}
}

func deferredJoinValid() {
	var wg sync.WaitGroup
	wg.Add(1)
	defer wg.Wait()
	go func() {
		defer wg.Done()
	}()
}

func infiniteLoopJoin(done chan struct{}) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	for {
		select {
		case <-done:
			wg.Wait()
			return
		default:
			wg.Wait()
			return
		}
	}
}

func earlyReturnBypass(abort bool) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	if abort {
		return
	}
	wg.Wait()
}

func conditionalWaitBypass(cond bool) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	if cond {
		wg.Wait()
	}
}

func uncalledClosureWaitBypass() {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	cleanup := func() {
		wg.Wait()
	}
	_ = cleanup
}

func nestedClosureWaitBypass() {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	func() {
		wg.Wait()
	}()
}

func multiSendSingleReceiveBypass() {
	out := make(chan int)
	go func() {
		defer close(out)
		for i := 0; i < 100; i++ {
			out <- i
		}
	}()
	<-out
}

func bufferedReceiveBypass() {
	done := make(chan struct{}, 1)
	go func() {
		close(done)
	}()
	<-done
}

func closeThenWorkBypass() {
	done := make(chan struct{})
	go func() {
		close(done)
		doWork()
	}()
	<-done
}

func gotoBypass(skip bool) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	if skip {
		goto done
	}
	wg.Wait()
done:
	return
}

func addOutsideLaunchListBypass() {
	var wg sync.WaitGroup
	wg.Add(1)
	for _, x := range []int{1} {
		go func(v int) {
			defer wg.Done()
			_ = v
		}(x)
	}
	wg.Wait()
}

func gotoOverDeferBypass() {
	var wg sync.WaitGroup
	wg.Add(1)
	goto Work
	defer wg.Wait()
Work:
	go func() {
		defer wg.Done()
	}()
}

func labeledBranchBeforeDefer() {
	var wg sync.WaitGroup
	wg.Add(1)
Loop:
	for i := 0; i < 2; i++ {
		if i == 1 {
			break Loop
		}
	}
	defer wg.Wait()
	go func() {
		defer wg.Done()
	}()
}

func deferredJoinAfterReturnBypass(cond bool) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	if cond {
		return
	}
	defer wg.Wait()
}

func conditionalDeferBypass(cond bool) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
	}()
	if cond {
		defer wg.Wait()
	}
}

func namedFunctionLaunch() {
	go doWork()
}

func doWork() {}

func done() chan struct{} {
	return make(chan struct{})
}
`

	want := map[string]bool{
		// Recognized joins.
		"waitGroupJoin":       true,
		"loopLaunchWaitAfter": true,
		"errgroupJoin":        true,
		"channelDrainJoin":    true,
		"closeSignalJoin":     true,
		"deferredJoinValid":   true,
		"infiniteLoopJoin":    true,
		// Bypasses that must be reported as unjoined.
		"earlyReturnBypass":             false,
		"conditionalWaitBypass":         false,
		"uncalledClosureWaitBypass":     false,
		"nestedClosureWaitBypass":       false,
		"multiSendSingleReceiveBypass":  false,
		"bufferedReceiveBypass":         false,
		"closeThenWorkBypass":           false,
		"gotoBypass":                    false,
		"addOutsideLaunchListBypass":    false,
		"deferredJoinAfterReturnBypass": false,
		"conditionalDeferBypass":        false,
		"namedFunctionLaunch":           false,
		// A goto or labeled branch ahead of the launch disqualifies the deferred
		// join pre-check: control can reach the launch without registering the
		// defer. The second case is the conservative side of that rule — the
		// defer does run there, but the guard refuses to rely on a prefix it
		// cannot follow.
		"gotoOverDeferBypass":      false,
		"labeledBranchBeforeDefer": false,
	}

	found := scanGoSample(t, src)
	if len(found) != len(want) {
		t.Fatalf("proof found %d findings, want %d: %v", len(found), len(want), found)
	}
	for fn, wantJoined := range want {
		site, ok := found[fn]
		if !ok {
			t.Errorf("proof missed the launch in %s", fn)
			continue
		}
		if site.Joined != wantJoined {
			t.Errorf("%s: joined=%v, want %v (evidence: %s)", fn, site.Joined, wantJoined, site.Evidence)
		}
		if wantJoined && site.Evidence == "" {
			t.Errorf("%s: accepted as joined with no evidence", fn)
		}
	}
}

// TestGoTimerProof proves the timer half of the Go detector: a timer that
// schedules work and is not stopped on every path is reported, and a timer a
// dominating Stop or channel receive releases is not. The conditional-stop cases
// are the Go half of the round-2 false negative: a `Stop()` that only one path
// reaches used to suppress the site entirely.
func TestGoTimerProof(t *testing.T) {
	const src = `package sample

import (
	"time"

	tm "time"
)

func afterFuncUnmanaged() {
	time.AfterFunc(time.Second, func() {})
}

func tickUnmanaged() {
	for range time.Tick(time.Second) {
		break
	}
}

func newTimerStopped() {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	<-timer.C
}

func newTickerUnstopped() {
	ticker := time.NewTicker(time.Second)
	<-ticker.C
}

func newTimerDiscarded() {
	<-time.NewTimer(time.Second).C
}

func newTimerStoppedInSelect() {
	timer := time.NewTimer(time.Second)
	select {
	case <-timer.C:
	case <-time.After(0):
		timer.Stop()
	}
}

func aliasedAfterFuncUnmanaged() {
	tm.AfterFunc(time.Second, func() {})
}

func aliasedTickerStopped() {
	ticker := tm.NewTicker(time.Second)
	defer ticker.Stop()
}

func aliasedTimerStoppedInCondition() {
	timer := tm.NewTimer(time.Second)
	select {
	case <-timer.C:
	case <-time.After(0):
		if !timer.Stop() {
			<-timer.C
		}
	}
}

func conditionalStopBypass(cond bool) {
	timer := time.NewTimer(time.Second)
	if cond {
		timer.Stop()
	}
}

func conditionalTickerStopBypass(cond bool) {
	ticker := time.NewTicker(time.Second)
	if cond {
		ticker.Stop()
	}
}
`

	want := map[string]bool{
		// Reported: nothing releases the handle on every path.
		"afterFuncUnmanaged":          true,
		"tickUnmanaged":               true,
		"newTickerUnstopped":          true,
		"newTimerDiscarded":           true,
		"aliasedAfterFuncUnmanaged":   true,
		"conditionalStopBypass":       true,
		"conditionalTickerStopBypass": true,
		// Accepted: a dominating join releases the handle.
		"newTimerStopped":                false,
		"newTimerStoppedInSelect":        false,
		"aliasedTickerStopped":           false,
		"aliasedTimerStoppedInCondition": false,
	}

	flagged := 0
	for _, wantFlagged := range want {
		if wantFlagged {
			flagged++
		}
	}
	found := scanGoSample(t, src)
	if len(found) != flagged {
		t.Fatalf("detector found %d timer findings, want %d: %v", len(found), flagged, found)
	}
	for fn, wantFlagged := range want {
		site, ok := found[fn]
		if !ok {
			if wantFlagged {
				t.Errorf("detector missed the unjoined timer in %s", fn)
			}
			continue
		}
		if site.Kind != "detached-timer" {
			t.Errorf("%s: kind=%q, want detached-timer", fn, site.Kind)
		}
		if wantFlagged && site.Joined {
			t.Errorf("%s: timer reported as joined, but nothing releases it", fn)
		}
		if !wantFlagged {
			t.Errorf("%s: released timer reported as detached: %s", fn, site.Evidence)
		}
	}
}

// TestGoScopeNamesTheEnclosingFunction proves a launch inside a closure is keyed
// by the function that owns the closure, so two closures in one file cannot
// collide and a reader can find the code (G4).
func TestGoScopeNamesTheEnclosingFunction(t *testing.T) {
	const src = `package sample

func outer() {
	func() {
		go work()
	}()
	go work()
}

func other() {
	go work()
}

func work() {}
`

	sites, err := scanGoSource(token.NewFileSet(), "sample.go", []byte(src))
	if err != nil {
		t.Fatalf("parse sample: %v", err)
	}
	got := make([]string, 0, len(sites))
	for _, s := range sites {
		got = append(got, s.Func)
	}
	sortStrings(got)
	want := []string{"other", "outer", "outer.<func literal>"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("owner names = %v, want %v", got, want)
	}
}

func sortStrings(in []string) {
	for i := 1; i < len(in); i++ {
		for j := i; j > 0 && in[j] < in[j-1]; j-- {
			in[j], in[j-1] = in[j-1], in[j]
		}
	}
}

// TestMissingInterpreterFails proves a missing interpreter is a failure, never a
// silent skip: an empty PATH makes both scanners report the missing interpreter
// instead of reporting an empty (vacuously clean) result.
func TestMissingInterpreterFails(t *testing.T) {
	dir := t.TempDir()
	for name, src := range map[string]string{
		"fixture.ts": "async function work(): Promise<void> {}\nwork();\n",
		"fixture.py": "import asyncio\nasyncio.create_task(work())\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o600); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}

	t.Setenv("PATH", t.TempDir())

	if _, err := scanTypeScript(dir); !errors.Is(err, errInterpreterMissing) {
		t.Fatalf("scanTypeScript with no node: err = %v, want errInterpreterMissing", err)
	}
	if _, err := pythonInterpreterAt(dir); !errors.Is(err, errInterpreterMissing) {
		t.Fatalf("pythonInterpreterAt with no python: err = %v, want errInterpreterMissing", err)
	}
}

// TestSiteKeyNamesTheFunctionAndCannotCollide proves the key shape itself, with
// no scanner in the loop: the enclosing function is part of the key, and two
// sites in different functions of one file cannot share a key
// (SAN-AT1070-R2-F2).
func TestSiteKeyNamesTheFunctionAndCannotCollide(t *testing.T) {
	sites := assignNth([]site{
		{path: "a.ts", fn: "A.start", kind: "timer-setTimeout", line: 3},
		{path: "a.ts", fn: "B.start", kind: "timer-setTimeout", line: 8},
		{path: "a.ts", fn: "A.start", kind: "timer-setTimeout", line: 20},
	})
	if len(sites) != 3 {
		t.Fatalf("assignNth dropped a site: %+v", sites)
	}
	seen := map[string]bool{}
	for _, s := range sites {
		if !strings.Contains(s.key(), s.fn) {
			t.Fatalf("site key %s does not name the enclosing function %s", s.key(), s.fn)
		}
		if seen[s.key()] {
			t.Fatalf("two sites collided on key %s", s.key())
		}
		seen[s.key()] = true
	}
	if sites[0].key() != "a.ts|A.start[#1]" || sites[1].key() != "a.ts|B.start[#1]" || sites[2].key() != "a.ts|A.start[#2]" {
		t.Fatalf("unexpected keys: %s, %s, %s", sites[0].key(), sites[1].key(), sites[2].key())
	}
}
