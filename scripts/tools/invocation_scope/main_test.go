package main

import (
	"os"
	"path/filepath"
	"testing"
)

// These tests prove the detectors are not vacuous: every asynchronous construct
// the guard is meant to catch is caught, and the joined forms of the same
// construct are not. A detector that silently stopped matching would fail here
// before it could pass the repository sweep.

func writeFixture(t *testing.T, dir, name, content string) {
	t.Helper()

	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatalf("write fixture %s: %v", name, err)
	}
}

func siteKinds(sites []site) map[string]int {
	out := map[string]int{}
	for _, s := range sites {
		out[s.fn]++
	}
	return out
}

func goSites(t *testing.T, src string) []site {
	t.Helper()

	dir := t.TempDir()
	writeFixture(t, dir, "fixture.go", src)
	return scanGo(dir)
}

func tsSites(t *testing.T, src string) []site {
	t.Helper()

	dir := t.TempDir()
	writeFixture(t, dir, "fixture.ts", src)
	return scanTypeScript(dir)
}

func pySites(t *testing.T, src string) []site {
	t.Helper()

	dir := t.TempDir()
	writeFixture(t, dir, "fixture.py", src)
	return scanPython(dir)
}

func TestGoDetectorFlagsEveryAsyncLaunchForm(t *testing.T) {
	flagged := []struct {
		name string
		src  string
		kind string
	}{
		{
			"go-statement",
			"package fixture\n\nfunc launch() {\n\tgo func() {}()\n}\n",
			"launch",
		},
		{
			"time-after-func",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\ttime.AfterFunc(time.Second, func() {})\n}\n",
			"time.AfterFunc",
		},
		{
			"time-new-timer",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\tt := time.NewTimer(time.Second)\n\t_ = t\n}\n",
			"time.NewTimer",
		},
		{
			"time-new-ticker",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\ttk := time.NewTicker(time.Second)\n\t_ = tk\n}\n",
			"time.NewTicker",
		},
		{
			"time-tick",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\t_ = time.Tick(time.Second)\n}\n",
			"time.Tick",
		},
	}
	for _, tc := range flagged {
		t.Run(tc.name, func(t *testing.T) {
			if got := siteKinds(goSites(t, tc.src))[tc.kind]; got == 0 {
				t.Fatalf("expected %s to be flagged, got %v", tc.kind, goSites(t, tc.src))
			}
		})
	}

	clean := []struct {
		name string
		src  string
	}{
		{
			"stopped-timer",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\tt := time.NewTimer(time.Second)\n\tdefer t.Stop()\n\t<-t.C\n}\n",
		},
		{
			"stopped-ticker",
			"package fixture\n\nimport \"time\"\n\nfunc arm() {\n\ttk := time.NewTicker(time.Second)\n\tdefer tk.Stop()\n\t<-tk.C\n}\n",
		},
		{
			"no-async-work",
			"package fixture\n\nfunc work() {}\n",
		},
	}
	for _, tc := range clean {
		t.Run(tc.name, func(t *testing.T) {
			if sites := goSites(t, tc.src); len(sites) != 0 {
				t.Fatalf("expected no launch sites, got %v", sites)
			}
		})
	}
}

func TestTypeScriptDetectorFlagsEveryAsyncForm(t *testing.T) {
	flagged := []struct {
		name string
		src  string
		kind string
	}{
		{"queue-microtask", "queueMicrotask(() => {});\n", "microtask"},
		{"next-tick", "process.nextTick(() => {});\n", "next-tick"},
		{"next-tick-bracket", "process[\"nextTick\"](() => {});\n", "next-tick-bracket"},
		{"set-immediate", "setImmediate(() => {});\n", "immediate"},
		{"set-immediate-bracket", "globalThis[\"setImmediate\"](() => {});\n", "immediate-bracket"},
		{"timer-bracket", "globalThis[\"setTimeout\"](() => {}, 1);\n", "timer-bracket"},
		{"async-iife", "(async () => {})();\n", "async-iife"},
		{"floating-then", "promise.then(handle);\n", "floating-then"},
		{"floating-catch", "promise.catch(handle);\n", "floating-catch"},
		{"floating-finally", "promise.finally(handle);\n", "floating-finally"},
		{"floating-multiline-chain", "service\n  .close(id)\n  .catch(() => undefined);\n", "floating-catch"},
		{"discarded-async-call", "async function work() {}\nwork();\n", "discarded-async-call"},
	}
	for _, tc := range flagged {
		t.Run(tc.name, func(t *testing.T) {
			if got := siteKinds(tsSites(t, tc.src))[tc.kind]; got == 0 {
				t.Fatalf("expected %s to be flagged, got %v", tc.kind, tsSites(t, tc.src))
			}
		})
	}

	clean := []struct {
		name string
		src  string
	}{
		{"awaited-catch", "async function run() {\n  await promise.catch(handle);\n}\n"},
		{"awaited-multiline-chain", "async function run() {\n  await service\n    .close(id)\n    .catch(() => undefined);\n}\n"},
		{"assigned-chain", "const p = promise.then(handle);\n"},
		{"returned-chain", "function f() {\n  return promise.finally(handle);\n}\n"},
	}
	for _, tc := range clean {
		t.Run(tc.name, func(t *testing.T) {
			if sites := tsSites(t, tc.src); len(sites) != 0 {
				t.Fatalf("expected no sites, got %v", sites)
			}
		})
	}
}

func TestPythonDetectorFlagsEveryAsyncForm(t *testing.T) {
	flagged := []struct {
		name string
		src  string
		kind string
	}{
		{"thread", "import threading\n\nworker = threading.Thread(target=run)\nworker.start()\n", "thread"},
		{"to-thread", "import asyncio\n\nasyncio.to_thread(run)\n", "to-thread"},
		{"run-in-executor", "loop.run_in_executor(None, run)\n", "run-in-executor"},
		{"daemon-kwarg", "import threading\n\nworker = threading.Thread(target=run, daemon=True)\n", "daemon-thread"},
		{"daemon-assign", "worker.daemon = True\n", "daemon-thread"},
		{
			"thread-comprehension",
			"import threading\n\nworkers = [\n    threading.Thread(target=run, args=(i,))\n    for i in range(3)\n]\n",
			"thread-comprehension",
		},
	}
	for _, tc := range flagged {
		t.Run(tc.name, func(t *testing.T) {
			if got := siteKinds(pySites(t, tc.src))[tc.kind]; got == 0 {
				t.Fatalf("expected %s to be flagged, got %v", tc.kind, pySites(t, tc.src))
			}
		})
	}

	clean := []struct {
		name string
		src  string
	}{
		{"awaited-to-thread", "import asyncio\n\nasync def run_all():\n    await asyncio.to_thread(work)\n"},
		{"awaited-run-in-executor", "async def run_all():\n    await loop.run_in_executor(None, work)\n"},
	}
	for _, tc := range clean {
		t.Run(tc.name, func(t *testing.T) {
			if sites := pySites(t, tc.src); len(sites) != 0 {
				t.Fatalf("expected no sites, got %v", sites)
			}
		})
	}
}
