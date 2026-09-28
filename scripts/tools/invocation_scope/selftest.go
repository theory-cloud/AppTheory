package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The guard's self-test battery proves each scanner is neither vacuous nor
// defeated by the spelling of a join. Every "unjoined" probe is a launch whose
// join does not dominate every exit — the shapes a presence- or text-based
// reading accepts by mistake — and every "joined" probe is a launch a dominating
// join covers. The probes are the ones the AppTheory invocation-scope round-2
// sanity review and the TableTheory detached-work guard rounds 1-3 used, ported
// here with the launch forms this repository's guard contract names (aliased
// imports, walrus bindings, aggregates, expression positions, class-field
// initializers, compound and chained assignments).
//
// The battery needs the TypeScript compiler and a Python interpreter, so
// scripts/verify-invocation-scope.sh installs the TypeScript runtime deps (the
// repository's own ts/node_modules contract) and runs it inside `make rubric`.
// It is deliberately not part of `go test`: verify-builds.sh snapshots the
// tracked tree, which has no node_modules, and a scanner that cannot run must
// fail the guard rather than be skipped.

// tsFlaggedProbes are the TypeScript shapes the scanner must report.
var tsFlaggedProbes = []struct{ name, src, rule string }{
	{"void call", "void sendNotification(user);", "void-call"},
	{"void iife", "void (async () => { await work(); })();", "void-call"},
	{"void bracket call", "void obj[\"send\"](user);", "void-call"},
	{"bare then", "fetchUser(id).then((user) => { render(user); });", "floating-then"},
	{"bare then on literal", "Promise.resolve(1).then((v) => console.log(v));", "floating-then"},
	{"bare catch", "sendWebhook(job).catch((err) => { log(err); });", "floating-catch"},
	{"bare finally", "flushQueue().finally(() => { markDone(); });", "floating-finally"},
	{"async iife", "(async () => {\n  await work();\n})();", "detached-async-iife"},
	{"async function iife", "(async function () {\n  await work();\n})();", "detached-async-iife"},
	{"queueMicrotask", "queueMicrotask(() => { flush(); });", "queue-microtask"},
	{"bracket queueMicrotask", "globalThis[\"queueMicrotask\"](() => { flush(); });", "queue-microtask"},
	{"process.nextTick", "process.nextTick(() => { flush(); });", "process-next-tick"},
	{"bracket process.nextTick", "process[\"nextTick\"](() => { flush(); });", "process-next-tick"},
	{"discarded async call", "async function syncUser(id: string): Promise<void> {\n  await write(id);\n}\nsyncUser(\"u1\");", "discarded-async-call"},
	{"discarded async arrow call", "const flush = async (): Promise<void> => {\n  await write();\n};\nflush();", "discarded-async-call"},
	{"unmanaged timer", "setTimeout(() => flush(), 1000);", "timer-setTimeout"},
	{"unmanaged interval", "setInterval(poll, 5000);", "timer-setInterval"},
	{"bracket timer", "globalThis[\"setTimeout\"](() => flush(), 1000);", "timer-setTimeout"},
	{"bracket interval", "window[\"setInterval\"](poll, 5000);", "timer-setInterval"},
	{"bracket immediate", "global[\"setImmediate\"](work);", "timer-setImmediate"},
	// A bound promise is a launch; a join that does not dominate is not one.
	{"bound chain returned on one path only", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  if (cond) return;\n  await p;\n}", "floating-then"},
	{"bound chain awaited inside a conditional", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  if (cond) {\n    await p;\n  }\n}", "floating-then"},
	{"assigned catch never awaited", "const settled = sendWebhook(job).catch((err) => { log(err); });", "floating-catch"},
	{"held promise awaited in one branch only", "async function run(c) {\n  const p = load(id).then((u) => render(u));\n  if (c) {\n    await p;\n  }\n  work();\n}", "floating-then"},
	{"held promise awaited before a later throw", "async function run(c) {\n  const p = load(id).then((u) => render(u));\n  if (c) throw new Error('x');\n  await p;\n}", "floating-then"},
	{"held promise awaited inside a loop body", "async function run(xs) {\n  const p = load(id).then((u) => render(u));\n  for (const x of xs) {\n    await p;\n  }\n}", "floating-then"},
	// A join that only some paths execute is not a join: the one-line
	// guarded, expression-position and non-declaration spellings a line-based
	// reading accepted (invocation-scope round-2 SAN-AT1070-R2-F1).
	{"one-line if await", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  if (cond) await p;\n}", "floating-then"},
	{"ternary await", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  cond ? await p : null;\n}", "floating-then"},
	{"short-circuit await", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  cond && await p;\n}", "floating-then"},
	{"join only inside a nested arrow", "async function run() {\n  const p = load(id).then((u) => render(u));\n  const w = async () => await p;\n}", "floating-then"},
	{"member-held promise", "class C {\n  pending: Promise<void> = Promise.resolve();\n  start() {\n    this.pending = load(id).then((u) => render(u));\n  }\n}", "floating-then"},
	{"rebound promise", "async function run() {\n  let p;\n  p = load(id).then((u) => render(u));\n}", "floating-then"},
	{"container-held promise", "async function run() {\n  const jobs: Record<string, Promise<void>> = {};\n  jobs[\"a\"] = load(id).then((u) => render(u));\n}", "floating-then"},
	{"compound assignment", "async function run() {\n  let p: Promise<void> | undefined;\n  p ??= load(id).then((u) => render(u));\n}", "floating-then"},
	{"chained assignment", "async function run() {\n  let a, b;\n  a = b = load(id).then((u) => render(u));\n}", "floating-then"},
	{"class field initializer", "class C {\n  pending = load(id).then((u) => render(u));\n}", "floating-then"},
	{"static block launch", "class C {\n  static {\n    setTimeout(() => flush(), 1000);\n  }\n}", "timer-setTimeout"},
	{"expression argument", "async function work2(): Promise<void> {}\nconst arr: Promise<void>[] = [];\narr.push(work2());", "discarded-async-call"},
	{"comma statement", "void 0, sendWebhook(job).catch((err) => { log(err); });", "floating-catch"},
	{"array aggregate element", "async function work2(): Promise<void> {}\nconst arr: Promise<void>[] = [];\narr.push((async () => {})());", "detached-async-iife"},
	{"destructuring aggregate", "async function load1(): Promise<void> {}\nconst [a, b] = [load1(), load1()];", "discarded-async-call"},
	{"array aggregate binding", "async function load1(): Promise<void> {}\nconst jobs = [load1(), load1()];", "discarded-async-call"},
	// An `unref()` is not a join: it releases the event loop, not the
	// callback, and the clear below runs in a closure the caller may never
	// call.
	{"unref is not a join", "const timer = setTimeout(() => controller.abort(), ms);\ntimer.unref?.();\nexport function cleanup() { clearTimeout(timer); }", "timer-setTimeout"},
	// A try whose handler can skip the join, or whose body joins only at its end.
	{"join at the end of a try body with a handler", "async function run() {\n  const p = load(id).then((u) => render(u));\n  try {\n    work();\n    await p;\n  } catch (e) {\n    log(e);\n  }\n}", "floating-then"},
	{"rebound async call not awaited", "async function run() {\n  let p: Promise<void>;\n  p = flushAsync();\n}\nasync function flushAsync(): Promise<void> {\n  await work();\n}", "discarded-async-call"},
}

// tsCleanProbes are the TypeScript shapes the scanner must accept.
var tsCleanProbes = []struct{ name, src string }{
	{"awaited promise delay", "await new Promise((r) => setTimeout(r, ms));"},
	{"block promise delay", "await new Promise<void>((resolve) => {\n  setTimeout(resolve, 200);\n});"},
	{"managed timer", "const timer = setTimeout(() => controller.abort(), ms);\nclearTimeout(timer);"},
	{"managed bracket timer", "const timer = globalThis[\"setTimeout\"](() => controller.abort(), ms);\nclearTimeout(timer);"},
	{"managed timer in a finally", "function withBudget(ms: number) {\n  const timer = setTimeout(() => controller.abort(), ms);\n  try {\n    return work();\n  } finally {\n    clearTimeout(timer);\n  }\n}"},
	{"managed timer in a deferred finally", "async function withBudget(ms: number) {\n  const timer = setTimeout(() => controller.abort(), ms);\n  try {\n    return await work();\n  } finally {\n    clearTimeout(timer);\n  }\n}"},
	{"awaited then", "const p = sem.acquire().then(() => { release(); });\nawait p;"},
	{"returned then", "return fetchThing().then((x) => x.value);"},
	{"awaited catch", "await sendWebhook(job).catch((err) => { log(err); });"},
	{"returned finally", "return flushQueue().finally(() => { markDone(); });"},
	{"bound promise awaited", "async function run() {\n  const p = load(id).then((u) => render(u));\n  await p;\n}"},
	{"bound promise returned", "async function run() {\n  const p = load(id).then((u) => render(u));\n  return p;\n}"},
	{"bound promise awaited before a later return", "async function run(cond) {\n  const p = load(id).then((u) => render(u));\n  await p;\n  if (cond) return;\n}"},
	{"awaited async call", "async function syncUser(id: string): Promise<void> {\n  await write(id);\n}\nawait syncUser(\"u1\");"},
	{"returned async call", "async function syncUser(id: string): Promise<void> {\n  await write(id);\n}\nreturn syncUser(\"u1\");"},
	{"async callback in map", "const users = await Promise.all(actions.map(async (_, index) => await load(index)));"},
	{"comment", "// void sendNotification(user) is deliberately not used here"},
	{"comment catch", "// sendWebhook(job).catch((err) => log(err)); is deliberately not used here"},
	// A join that dominates on every path is accepted, in every spelling.
	{"held promise awaited in both try branches", "async function run() {\n  const p = load(id).then((u) => render(u));\n  try {\n    work();\n  } catch (e) {\n    await p;\n  }\n  await p;\n}"},
	{"join in finally dominates", "async function run(c) {\n  const p = load(id).then((u) => render(u));\n  try {\n    if (c) return 1;\n    return 2;\n  } finally {\n    await p;\n  }\n}"},
	{"if/else both branches join", "async function run(c) {\n  const p = load(id).then((u) => render(u));\n  if (c) {\n    await p;\n  } else {\n    await p;\n  }\n}"},
	{"await Promise.all over a held promise", "async function run() {\n  const p = load(id).then((u) => render(u));\n  await Promise.all([p]);\n}"},
	{"await Promise.allSettled over a held promise", "async function run() {\n  const p = load(id).then((u) => render(u));\n  await Promise.allSettled([p]);\n}"},
	{"held async-callback array joined", "async function run() {\n  const workers = Array.from({ length: 2 }, async () => { await work(); });\n  await Promise.allSettled(workers);\n}"},
	{"rebound promise awaited", "async function run() {\n  let p;\n  p = load(id).then((u) => render(u));\n  await p;\n}"},
	{"container-held promise awaited", "async function run() {\n  const jobs: Record<string, Promise<void>> = {};\n  jobs[\"a\"] = load(id).then((u) => render(u));\n  await jobs[\"a\"];\n}"},
	{"bind and await on one line", "async function run() {\n  const p = load(id).then((u) => render(u)); await p;\n}"},
	{"compound assignment then awaited", "async function run() {\n  let p: Promise<void> | undefined;\n  p ??= load(id).then((u) => render(u));\n  await p;\n}"},
	{"chained assignment then awaited", "async function run() {\n  let a, b;\n  a = b = load(id).then((u) => render(u));\n  await b;\n}"},
	{"destructuring aggregate joined", "async function load1(): Promise<void> {}\nasync function run() {\n  const [a, b] = [load1(), load1()];\n  await Promise.all([a, b]);\n}"},
	{"array aggregate joined", "async function load1(): Promise<void> {}\nasync function run() {\n  const jobs = [load1(), load1()];\n  await Promise.all(jobs);\n}"},
}

// pyFlaggedProbes are the Python shapes the scanner must report.
var pyFlaggedProbes = []struct{ name, src, rule string }{
	{"thread started", "t = threading.Thread(target=work)\nt.start()\n", "thread-start"},
	{"thread inline", "threading.Thread(target=work).start()\n", "thread-start"},
	{"timer started", "t = threading.Timer(5.0, work)\nt.start()\n", "thread-start"},
	{"process started", "p = multiprocessing.Process(target=work)\np.start()\n", "thread-start"},
	{"annotated thread start", "t: threading.Thread = threading.Thread(target=work)\nt.start()\n", "thread-start"},
	{"thread comprehension", "threads = [threading.Thread(target=work) for _ in range(4)]\n", "thread-comprehension"},
	{"multiline thread comprehension", "threads = [\n    threading.Thread(target=work)\n    for _ in range(4)\n]\nfor t in threads:\n    t.start()\n", "thread-comprehension"},
	{"daemon thread inline", "threading.Thread(target=work, daemon=True).start()\n", "daemon-thread"},
	{"daemon thread named", "t = threading.Thread(target=work, daemon=True)\nt.start()\n", "daemon-thread"},
	{"daemon attribute", "t = threading.Thread(target=work)\nt.daemon = True\nt.start()\n", "daemon-thread"},
	{"create_task", "asyncio.create_task(work())\n", "asyncio-task"},
	{"ensure_future", "task = asyncio.ensure_future(work())\n", "asyncio-task"},
	{"loop create_task", "task = loop.create_task(work())\n", "asyncio-task"},
	{"canceled but not awaited", "task = asyncio.create_task(work())\ntask.cancel()\n", "asyncio-task"},
	{"to_thread not awaited", "result = asyncio.to_thread(compute, arg)\n", "asyncio-to-thread"},
	{"to_thread bare", "asyncio.to_thread(compute, arg)\n", "asyncio-to-thread"},
	{"run_in_executor not awaited", "future = loop.run_in_executor(pool, compute)\n", "run-in-executor"},
	{"submit outside with", "ex = ThreadPoolExecutor(max_workers=4)\nex.submit(work)\n", "executor-submit"},
	// An aliased import is the same launch.
	{"aliased module thread", "import threading as th\nw = th.Thread(target=work)\nw.start()\n", "thread-start"},
	{"aliased from-import thread", "from threading import Thread as T\nt = T(target=work)\nt.start()\n", "thread-start"},
	{"aliased module task", "import asyncio as aio\ntask = aio.create_task(work())\n", "asyncio-task"},
	// A join that is present but does not dominate is not a join.
	{"walrus thread unjoined", "if (t := threading.Thread(target=work)):\n    t.start()\n", "thread-start"},
	{"walrus task unjoined", "if (t := asyncio.create_task(work())):\n    pass\n", "asyncio-task"},
	{"tuple aggregate one join", "t1, t2 = threading.Thread(target=work), threading.Thread(target=work)\nt1.start()\nt2.start()\nt1.join()\n", "thread-start"},
	{"list aggregate loop unjoined", "threads = [threading.Thread(target=work), threading.Thread(target=work)]\nfor t in threads:\n    t.start()\n", "thread-start"},
	{"conditional thread join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    if cond:\n        t.join()\n", "thread-start"},
	{"early return before join", "def run(abort):\n    t = threading.Thread(target=work)\n    t.start()\n    if abort:\n        return\n    t.join()\n", "thread-start"},
	{"single-line return before join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    if cond: return\n    t.join()\n", "thread-start"},
	{"raise before join", "def run():\n    t = threading.Thread(target=work)\n    t.start()\n    raise RuntimeError('stop')\n", "thread-start"},
	{"return inside a loop before the join", "def run(xs):\n    t = threading.Thread(target=work)\n    t.start()\n    for x in xs:\n        return\n    t.join()\n", "thread-start"},
	{"join inside a loop body", "def run(xs):\n    t = threading.Thread(target=work)\n    t.start()\n    for x in xs:\n        t.join()\n", "thread-start"},
	{"only one branch joins", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    if cond:\n        t.join()\n    work()\n", "thread-start"},
	{"thread joined in a nested function", "def run():\n    t = threading.Thread(target=work)\n    t.start()\n    def inner():\n        t.join()\n    inner()\n", "thread-start"},
	{"conditional task await", "async def run(cond):\n    task = asyncio.create_task(work())\n    if cond:\n        await task\n", "asyncio-task"},
	{"early return before await", "async def run(abort):\n    task = asyncio.create_task(work())\n    if abort:\n        return\n    await task\n", "asyncio-task"},
	// A thread held on an attribute or a container element is still a thread.
	{"self-held thread", "class W:\n    def go(self):\n        self.worker = threading.Thread(target=work)\n        self.worker.start()\n", "thread-start"},
	{"self-held thread conditional join", "class W:\n    def go(self, cond):\n        self.worker = threading.Thread(target=work)\n        self.worker.start()\n        if cond:\n            self.worker.join()\n", "thread-start"},
	{"container-held thread", "pool = {}\npool[\"a\"] = threading.Thread(target=work)\npool[\"a\"].start()\n", "thread-start"},
	{"offload conditional await", "async def run(cond):\n    result = asyncio.to_thread(compute, arg)\n    if cond:\n        await result\n", "asyncio-to-thread"},
	// A join that only some paths execute is not a join: the one-line
	// compound and expression-position spellings a line-based reading
	// accepted (invocation-scope round-2 SAN-AT1070-R2-F1).
	{"one-line if join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    if cond: t.join()\n", "thread-start"},
	{"await elsewhere on the line", "async def run():\n    result = asyncio.to_thread(compute, arg); other = await load()\n", "asyncio-to-thread"},
	{"executor await elsewhere on the line", "async def run():\n    future = loop.run_in_executor(pool, compute); other = await load()\n", "run-in-executor"},
	{"one-line for join", "def run(items):\n    t = threading.Thread(target=work)\n    t.start()\n    for x in items: t.join()\n", "thread-start"},
	{"one-line while join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    while cond: t.join()\n", "thread-start"},
	{"boolean-guard expression join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    ok = cond and t.join()\n", "thread-start"},
	{"conditional-expression join", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    t.join() if cond else None\n", "thread-start"},
	{"one-line conditional task await", "async def run(cond):\n    task = asyncio.create_task(work())\n    if cond: await task\n", "asyncio-task"},
	{"one-line conditional offload await", "async def run(cond):\n    result = asyncio.to_thread(compute, arg)\n    if cond: await result\n", "asyncio-to-thread"},
	// A try whose handler can skip the join, or whose body joins only at its end.
	{"join at the end of a try body with a handler", "def run():\n    t = threading.Thread(target=work)\n    t.start()\n    try:\n        work()\n        t.join()\n    except Exception:\n        pass\n", "thread-start"},
	{"non-exhaustive handler before the join", "def run():\n    t = threading.Thread(target=work)\n    t.start()\n    try:\n        work()\n    except ValueError:\n        pass\n    t.join()\n", "thread-start"},
}

// pyCleanProbes are the Python shapes the scanner must accept.
var pyCleanProbes = []struct{ name, src string }{
	{"submit inside with", "with ThreadPoolExecutor(max_workers=4) as ex:\n    futures = {ex.submit(scan, s): s for s in segs}\n    for f in futures:\n        f.result()\n"},
	{"task awaited", "task = asyncio.create_task(work())\nawait task\n"},
	{"tasks gathered inline", "results = await asyncio.gather(work_a(), work_b())\n"},
	{"thread joined", "t = threading.Thread(target=work)\nt.start()\nt.join()\n"},
	{"annotated thread joined", "t: threading.Thread = threading.Thread(target=work)\nt.start()\nt.join()\n"},
	{"daemon false joined", "t = threading.Thread(target=work, daemon=False)\nt.start()\nt.join()\n"},
	{"daemon true joined", "t = threading.Thread(target=work, daemon=True)\nt.start()\nt.join()\n"},
	{"to_thread awaited", "result = await asyncio.to_thread(compute, arg)\n"},
	{"run_in_executor awaited", "future = await loop.run_in_executor(pool, compute)\n"},
	{"unstarted thread list", "threads = [\n    threading.Thread(target=work),\n]\n"},
	{"comment", "# asyncio.create_task(work()) is deliberately not used here\n"},
	{"comment comprehension", "# threads = [threading.Thread(target=work) for _ in range(4)] is not used\n"},
	{"import only", "import threading\nlock = threading.Lock()\n"},
	// A dominating join is accepted.
	{"thread joined in function", "def run():\n    t = threading.Thread(target=work)\n    t.start()\n    t.join()\n"},
	{"thread joined before a later return", "def run(cond):\n    t = threading.Thread(target=work)\n    t.start()\n    t.join()\n    if cond:\n        return\n"},
	{"aliased module thread joined", "import threading as th\nw = th.Thread(target=work)\nw.start()\nw.join()\n"},
	{"walrus thread joined", "if (t := threading.Thread(target=work)):\n    t.start()\n    t.join()\n"},
	{"tuple aggregate joined", "t1, t2 = threading.Thread(target=work), threading.Thread(target=work)\nt1.start()\nt2.start()\nt1.join()\nt2.join()\n"},
	{"list aggregate loop joined", "threads = [threading.Thread(target=work), threading.Thread(target=work)]\nfor t in threads:\n    t.start()\n    t.join()\n"},
	{"self-held thread joined", "class W:\n    def go(self):\n        self.worker = threading.Thread(target=work)\n        self.worker.start()\n        self.worker.join()\n"},
	{"container-held thread joined", "pool = {}\npool[\"a\"] = threading.Thread(target=work)\npool[\"a\"].start()\npool[\"a\"].join()\n"},
	{"task awaited in return", "async def run():\n    task = asyncio.create_task(work())\n    other = await load()\n    return await task\n"},
	{"to_thread assigned then awaited", "result = asyncio.to_thread(compute, arg)\nvalue = await result\n"},
	// A join that dominates on every path is accepted, in every spelling.
	{"join in finally dominates", "def run(c):\n    t = threading.Thread(target=work)\n    t.start()\n    try:\n        if c:\n            return 1\n        return 2\n    finally:\n        t.join()\n"},
	{"if/else both branches join", "def run(c):\n    t = threading.Thread(target=work)\n    t.start()\n    if c:\n        t.join()\n    else:\n        t.join()\n"},
	{"if/elif/else all branches join", "def run(c):\n    t = threading.Thread(target=work)\n    t.start()\n    if c == 1:\n        t.join()\n    elif c == 2:\n        t.join()\n    else:\n        t.join()\n"},
	{"one line start then join", "def run():\n    t = threading.Thread(target=work)\n    t.start(); t.join()\n"},
	{"loop join with the join after the loop", "def run(xs):\n    t = threading.Thread(target=work)\n    t.start()\n    for x in xs:\n        work(x)\n    t.join()\n"},
	{"task gathered", "async def run():\n    task = asyncio.create_task(work())\n    await asyncio.gather(task)\n"},
	{"task awaited in both try and except", "async def run():\n    task = asyncio.create_task(work())\n    try:\n        work()\n    except Exception:\n        await task\n    else:\n        await task\n"},
	{"alias join", "def run():\n    t = threading.Thread(target=work)\n    u = t\n    u.start()\n    u.join()\n"},
	{"offload alias awaited", "async def run():\n    r = asyncio.to_thread(f)\n    alias = r\n    await alias\n"},
	// An inline offload is joined by the `await` that consumes it, on the
	// line and in a one-line conditional alike: the awaited promise is the
	// launch's own target.
	{"inline offload awaited", "async def run():\n    result = await asyncio.to_thread(compute, arg)\n"},
	{"one-line conditional inline offload awaited", "async def run(cond):\n    if cond: await asyncio.to_thread(compute, arg)\n"},
	{"both branches inline offload awaited", "async def run(cond):\n    if cond:\n        await asyncio.to_thread(compute, arg)\n    else:\n        await asyncio.to_thread(compute, arg)\n"},
}

// runSelfTest runs every probe and the scanner-level contract checks, and
// returns the first failure it finds.
func runSelfTest(out io.Writer) error {
	if err := checkProbes(out, ".ts", tsFlaggedProbes, tsCleanProbes); err != nil {
		return err
	}
	if err := checkProbes(out, ".py", pyFlaggedProbes, pyCleanProbes); err != nil {
		return err
	}

	// The TypeScript parser's own diagnostics fail the scan: a file the compiler
	// cannot parse has no proof at all.
	if _, err := scanFixtureSrc(".ts", "function broken( {\n"); err == nil {
		return fmt.Errorf("a TypeScript parse error must fail the scan, not pass silently")
	}
	if _, err := scanFixtureSrc(".py", "def broken(:\n"); err == nil {
		return fmt.Errorf("a Python syntax error must fail the scan, not pass silently")
	}

	// Two functions in one file sharing a launch kind must not collide on a site
	// key (SAN-AT1070-R2-F2): a baseline entry for one cannot excuse the other.
	dir, err := probeDir("invocation-scope-selftest-")
	if err != nil {
		return err
	}
	defer removeProbeDir(dir)
	writeErr := os.WriteFile(filepath.Join(dir, "fixture.ts"),
		[]byte("class A {\n  start(): void {\n    setTimeout(() => {}, 1);\n  }\n}\nclass B {\n  start(): void {\n    setTimeout(() => {}, 1);\n  }\n}\n"), 0o600)
	if writeErr != nil {
		return writeErr
	}
	sites, err := scanTypeScript(dir)
	if err != nil {
		return err
	}
	if len(sites) != 2 {
		return fmt.Errorf("want two reported launches for two functions, got %d", len(sites))
	}
	if sites[0].key() == sites[1].key() {
		return fmt.Errorf("two functions in one file collided on key %s", sites[0].key())
	}
	for _, s := range sites {
		if !strings.Contains(s.key(), "A.start") && !strings.Contains(s.key(), "B.start") {
			return fmt.Errorf("site key %s does not name the enclosing function", s.key())
		}
	}

	printLine(out, "invocation-scope: selftest PASS (%d TypeScript and %d Python probes)",
		len(tsFlaggedProbes)+len(tsCleanProbes), len(pyFlaggedProbes)+len(pyCleanProbes))
	return nil
}

// checkProbes runs one batch of probes through a scanner and asserts the flagged
// cases carry their rule and the clean cases carry nothing.
func checkProbes(out io.Writer, ext string, flagged []struct{ name, src, rule string }, clean []struct{ name, src string }) error {
	for _, tc := range flagged {
		findings, err := scanFixtureSrc(ext, tc.src+"\n")
		if err != nil {
			return fmt.Errorf("flagged/%s: %w", tc.name, err)
		}
		if !hasRule(findings, tc.rule) {
			return fmt.Errorf("flagged/%s: detector missed %q (want rule %s); got %+v", tc.name, tc.src, tc.rule, findings)
		}
	}
	for _, tc := range clean {
		findings, err := scanFixtureSrc(ext, tc.src+"\n")
		if err != nil {
			return fmt.Errorf("clean/%s: %w", tc.name, err)
		}
		if len(findings) > 0 {
			return fmt.Errorf("clean/%s: detector reported a joined form %q: %+v", tc.name, tc.src, findings)
		}
	}
	printLine(out, "invocation-scope: selftest %s probes PASS (%d flagged, %d joined)", ext, len(flagged), len(clean))
	return nil
}

// scanFixtureSrc runs the interpreter-driven scanner for one language over a
// single temporary source file.
func scanFixtureSrc(ext, src string) ([]scanFinding, error) {
	dir, err := probeDir("invocation-scope-probe-")
	if err != nil {
		return nil, err
	}
	defer removeProbeDir(dir)
	if writeErr := os.WriteFile(filepath.Join(dir, "fixture"+ext), []byte(src), 0o600); writeErr != nil {
		return nil, writeErr
	}
	files, err := collectSources(dir, ext)
	if err != nil {
		return nil, err
	}
	switch ext {
	case ".ts":
		node, err := exec.LookPath("node")
		if err != nil {
			return nil, fmt.Errorf("%w: node is required to parse TypeScript with the compiler API", errInterpreterMissing)
		}
		return runScanner(node, filepath.Join(guardDir(), "scan_typescript.mjs"), files)
	case ".py":
		interpreter, err := pythonInterpreterAt(repoRoot())
		if err != nil {
			return nil, err
		}
		return runScanner(interpreter, filepath.Join(guardDir(), "scan_python.py"), files)
	default:
		return nil, fmt.Errorf("unsupported fixture extension %s", ext)
	}
}

// printLine writes one line of self-test output. A failed write to the guard's
// own output is not actionable mid-run: the process exit status carries the
// result of the battery.
func printLine(out io.Writer, format string, args ...any) {
	if _, err := fmt.Fprintf(out, format+"\n", args...); err != nil {
		_ = err
	}
}

// probeDir makes a temporary directory for one probe fixture.
func probeDir(pattern string) (string, error) {
	return os.MkdirTemp("", pattern)
}

// removeProbeDir deletes a probe fixture directory, ignoring the error: the
// probe's result is what matters, and the directory is under the OS temp root.
func removeProbeDir(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		_ = err
	}
}

func hasRule(findings []scanFinding, rule string) bool {
	for _, f := range findings {
		if f.Rule == rule {
			return true
		}
	}
	return false
}
