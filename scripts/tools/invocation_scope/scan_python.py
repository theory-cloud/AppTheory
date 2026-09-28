#!/usr/bin/env python3
"""AST invocation-scope scanner for Python sources.

Invoked by scripts/tools/invocation_scope (the repository guard), which
scripts/verify-invocation-scope.sh runs — with this scanner and the guard's
self-tests — as part of `make rubric`. `make test-unit` is `go test` only and
never invokes this scanner, so the sweep is pinned by the rubric verifier and
not by the unit-test target.

Protocol (one request/response per process):

    request  := {"files": [{"path": "<repo-relative>", "source": "<text>"}]}
    response := {"results": [{"path": ..., "findings": [
                    {"line": <1-based>, "rule": "<rule>", "scope": "<enclosing scope>",
                     "text": "<source line>"}
                ], "error": null | "<message>"}]}

Proof, exactly: a launch is reported unless a join on the same target executes on
every path from the launch to every exit of the scope that contains it. The
source is parsed with `ast`, and each scope (module bodies, every function body,
including async ones, every class body, and every constructor-expression
position a `def`/`class` statement evaluates) gets a control-flow graph whose
nodes are statements and whose edges are fallthrough, branches, loop back-edges,
`break`/`continue` targets, and exception transfers into `except`/`finally`
clauses. `return` of the owning function and an unhandled `raise` are exits; a
nested `def` is an opaque statement, so its body's `return` is not this scope's
exit and its joins are not this scope's joins.

A launch is accepted only when no path from its statement to an exit avoids every
join statement, where a join statement is one that executes the join
unconditionally whenever it executes. A join nested in an `if` branch, a loop
body, a `try` body without a joining `finally`, a nested `def`/`lambda`/
comprehension, a conditional expression (`x if c else y`), or a boolean operator
(`c and x`) is not such a statement; neither is a join on a line that opens a
compound statement (`if cond: t.join()`, `for x in xs: t.join()`). A join in a
`finally` clause is reached from every exit and so dominates. A join split across
both branches of an `if/else` is accepted, because the graph merges the branches.

Recognized launches: `Thread`/`Timer`/`Process` `.start()` (including a thread
reached through an alias, a tuple/list/dict aggregate, or a `for` over an
aggregate), `create_task` / `ensure_future` / `loop.create_task`,
`asyncio.to_thread` / `run_in_executor`, `ThreadPoolExecutor` `.submit(` outside
a `with` block, a thread built inside a comprehension, and a daemon thread
(either `daemon=True` on the constructor or a later `x.daemon = True`) that is
started. Targets are tracked by name, attribute, and container element, with
simple `u = t` aliases resolved and `:=` walrus bindings honored, and the binding
of a target decides how far it is tracked:

  * A plain name bound inside a function is tracked in that function's scope
    only, and the parameter names a `def` gives default-argument constructors to
    are tracked in that `def`'s body, because a name bound in one frame is not
    assumed to be the same object in another.
  * An attribute (`self.worker`, `mod.worker`) or a container element
    (`pool["a"]`, `self.pool["a"]`) is tracked across the whole file, because the
    target belongs to the instance or the container rather than to the frame that
    assigned it: `self.worker` assigned in `__init__` and started in a sibling
    method names the same target. A plain name bound at module or class-body
    level is tracked across the whole file too (and, in a class body, also under
    `self.<name>` and `<Class>.<name>`), because a module global or a class
    attribute is reachable from every scope that names it.
  * A subscript whose key does not name a tracked binding is tracked
    conservatively: when the container it indexes holds a tracked launch, the
    read is reported, because the key the join must name cannot be matched.
  * The join proof stays in the function that starts the work. A join in a
    sibling method does not clean a launch, and no join in the scope that
    assigned the target is credited to the scope that starts it.

A task or offload is joined by `await target` (or `await asyncio.gather`/`wait`
over it); a thread by `target.join()`. `task.cancel()` is not a join, because
cancellation is cooperative and the task can still be running when the caller
returns.

Deliberately conservative, and documented as such in
docs/features/http-runtime.md:

  * Only exceptions raised inside a `try` body are modeled, and they transfer to
    that statement's handlers; an exception anywhere else is not an exit. This
    mirrors the Go scanner.
  * A `try` whose handlers are not exhaustive keeps a transfer edge to the
    enclosing exit, so a join after such a `try` is reported even though a
    catch-all would have proven it.
  * `with` does not join its body in general; an executor `submit` inside its own
    `with` block is joined lexically, which is the one context-manager join the
    guard recognizes.
  * A thread built inside a comprehension is reported even when a later loop
    starts and joins it: the comprehension hides the handle the guard tracks.
  * `await`ing the same target twice, or awaiting it in one branch and exiting on
    the other, is reported; both branches must join.
  * An attribute, container element, module global or class attribute is tracked
    file-wide, so a scope that rebinds the same key to something else does not
    un-track it: a later `.start()` on that key is still reported. The broader
    tracking errs toward reporting.
  * A constructor expression in a default argument, a decorator, or a class base
    or keyword is always reported when it launches, because no function's joins
    can dominate an expression evaluated where the `def`/`class` statement sits.
    A daemon-flagged thread constructor in one of those positions is reported for
    the same reason, even though no `.start()` in such a position could be
    joined.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any, Callable

THREAD_CTORS = ("threading.Thread", "threading.Timer", "multiprocessing.Process", "mp.Process")
TASK_METHODS = {"create_task", "ensure_future"}
OFFLOAD_METHODS = {"to_thread", "run_in_executor"}
GATHER_METHODS = {"gather", "wait"}

# Module names whose `Thread`/`Timer`/`Process` are thread constructors, and the
# executor module names, so `import threading as th` and `import
# concurrent.futures as cf` are recognized.
_THREAD_MODULES = {"threading", "multiprocessing", "mp"}
_EXECUTOR_SUFFIXES = ("Executor",)

# Expressions whose value is only conditionally evaluated when the enclosing
# statement executes, plus the compound statements whose own node must never be
# treated as a join. A join inside one of these is not a dominating join.
_CONDITIONAL: tuple[type, ...] = (
    ast.IfExp,
    ast.BoolOp,
    ast.Lambda,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
    ast.If,
    ast.While,
    ast.For,
    ast.AsyncFor,
    ast.With,
    ast.AsyncWith,
    ast.Try,
    ast.Match,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
)
_TRYSTAR = getattr(ast, "TryStar", None)
if _TRYSTAR is not None:
    _CONDITIONAL = _CONDITIONAL + (_TRYSTAR,)

_COMPOUND = (
    ast.If,
    ast.While,
    ast.For,
    ast.AsyncFor,
    ast.With,
    ast.AsyncWith,
    ast.Try,
    ast.Match,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
) + ((_TRYSTAR,) if _TRYSTAR is not None else ())

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


# ---------------------------------------------------------------------------
# Small textual helpers
# ---------------------------------------------------------------------------


def dotted(expr: ast.AST) -> str | None:
    """Return the dotted name of a Name/Attribute chain, or None."""
    parts: list[str] = []
    cur = expr
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return ".".join(reversed(parts))
    return None


def key_of(expr: ast.AST) -> str:
    """A stable textual key for an assignable expression."""
    try:
        return ast.unparse(expr)
    except Exception:  # pragma: no cover - unparse is total for parsed input
        return ""


def receiver_key(expr: ast.AST) -> str:
    """The key a `.start()` receiver names.

    `(t := Thread(...)).start()` names the same target as `t.start()`, so the
    walrus wrapper is unwrapped before the key is built.
    """
    if isinstance(expr, ast.NamedExpr):
        return key_of(expr.target)
    return key_of(expr)


def container_key(expr: ast.AST) -> str:
    """The key of the container a subscript expression reads: `pool[k]` -> `pool`."""
    cur = expr
    while isinstance(cur, ast.Subscript):
        cur = cur.value
    return key_of(cur)


def construct_kind(value: ast.AST, imports: Imports) -> str | None:
    """The launch kind a constructor expression creates, or None."""
    if imports.is_thread_ctor(value):
        return "thread"
    if isinstance(value, ast.Call) and call_short(value) in TASK_METHODS:
        return "task"
    if isinstance(value, ast.Call) and call_short(value) in OFFLOAD_METHODS:
        return "offload"
    return None


def call_short(call: ast.AST) -> str | None:
    if not isinstance(call, ast.Call):
        return None
    name = dotted(call.func)
    if name is None:
        return None
    return name.split(".")[-1]


def is_true_literal(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value is True


# ---------------------------------------------------------------------------
# Import resolution
# ---------------------------------------------------------------------------


class Imports:
    """The names this module binds for the asynchronous APIs we recognize."""

    def __init__(self) -> None:
        # Local name -> short constructor name, from `from threading import Thread as T`.
        self.thread_names: set[str] = set()
        # Local module name -> canonical module name, from `import threading as th`.
        self.module_aliases: dict[str, str] = {}

    def canonical_module(self, name: str) -> str:
        return self.module_aliases.get(name, name)

    def is_thread_ctor(self, call: ast.AST) -> bool:
        if not isinstance(call, ast.Call):
            return False
        if isinstance(call.func, ast.Name) and call.func.id in self.thread_names:
            return True
        name = dotted(call.func)
        if name is None:
            return False
        module, _, attr = name.rpartition(".")
        if self.canonical_module(module) in _THREAD_MODULES and attr in ("Thread", "Timer", "Process"):
            return True
        if name.startswith("multiprocessing.Process") or name.startswith("mp.Process"):
            return True
        return False

    def is_executor_ctor(self, expr: ast.AST) -> bool:
        name = dotted(expr.func) if isinstance(expr, ast.Call) else None
        if name is None:
            return False
        module, _, attr = name.rpartition(".")
        if attr.endswith(_EXECUTOR_SUFFIXES) and self.canonical_module(module) in (
            "concurrent.futures",
            "concurrent",
            "futures",
        ):
            return True
        return attr.endswith(_EXECUTOR_SUFFIXES)


def collect_imports(tree: ast.Module) -> Imports:
    imports = Imports()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            module = node.module.rpartition(".")[2]
            for alias in node.names:
                if module in _THREAD_MODULES and alias.name in ("Thread", "Timer", "Process"):
                    imports.thread_names.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                canonical = alias.name.split(".")[0]
                if canonical in ("threading", "multiprocessing", "concurrent"):
                    imports.module_aliases[alias.asname or canonical] = alias.name
    return imports


# ---------------------------------------------------------------------------
# Control-flow graph
# ---------------------------------------------------------------------------


class Node:
    __slots__ = ("succ", "stmt", "kind")

    def __init__(self, stmt: ast.AST | None = None, kind: str = "plain") -> None:
        self.succ: list[Node] = []
        self.stmt = stmt
        self.kind = kind  # "plain" | "exit"


class Ctx:
    __slots__ = ("exit", "exc", "brk", "cont", "guarded")

    def __init__(
        self,
        exit_: Node | None,
        exc: Node | None,
        brk: Node | None = None,
        cont: Node | None = None,
        guarded: bool = False,
    ) -> None:
        self.exit = exit_
        self.exc = exc
        self.brk = brk
        self.cont = cont
        self.guarded = guarded


def dedupe(nodes: list[Node | None]) -> list[Node]:
    out: list[Node] = []
    for n in nodes:
        if n is not None and n not in out:
            out.append(n)
    return out


class Graph:
    """Control-flow graph of one function scope."""

    def __init__(self) -> None:
        self.exit = Node(kind="exit")
        self.nodes_of_stmt: dict[int, list[Node]] = {}

    def node(self, stmt: ast.AST | None) -> Node:
        n = Node(stmt)
        if stmt is not None:
            self.nodes_of_stmt.setdefault(id(stmt), []).append(n)
        return n

    def seq(self, stmts: list[ast.stmt], k: Node, ctx: Ctx) -> Node:
        entry = k
        for stmt in reversed(stmts):
            entry = self.stmt(stmt, entry, ctx)
        return entry

    def stmt(self, stmt: ast.stmt, k: Node, ctx: Ctx) -> Node:
        t = type(stmt)
        if t is ast.Return:
            n = self.node(stmt)
            n.succ = dedupe([ctx.exit])
            return n
        if t is ast.Raise:
            n = self.node(stmt)
            n.succ = dedupe([ctx.exc])
            return n
        if t is ast.Break:
            n = self.node(stmt)
            n.succ = dedupe([ctx.brk])
            return n
        if t is ast.Continue:
            n = self.node(stmt)
            n.succ = dedupe([ctx.cont])
            return n
        if t is ast.If:
            n = self.node(stmt)
            then_e = self.seq(stmt.body, k, ctx)
            else_e = self.seq(stmt.orelse, k, ctx) if stmt.orelse else k
            n.succ = dedupe([then_e, else_e])
            return n
        if t in (ast.While, ast.For, ast.AsyncFor):
            n = self.node(stmt)
            orelse_e = self.seq(stmt.orelse, k, ctx) if stmt.orelse else k
            body_ctx = Ctx(ctx.exit, ctx.exc, brk=k, cont=n, guarded=ctx.guarded)
            body_e = self.seq(stmt.body, n, body_ctx)
            n.succ = dedupe([body_e, orelse_e])
            return n
        if t in (ast.With, ast.AsyncWith):
            n = self.node(stmt)
            body_e = self.seq(stmt.body, k, ctx)
            n.succ = dedupe([body_e, ctx.exc] if ctx.guarded else [body_e])
            return n
        if t is ast.Try or (_TRYSTAR is not None and t is _TRYSTAR):
            return self.try_stmt(stmt, k, ctx)
        if t is ast.Match:
            n = self.node(stmt)
            entries = [self.seq(case.body, k, ctx) for case in stmt.cases]
            n.succ = dedupe(entries + [k])
            return n
        if t in (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef):
            n = self.node(stmt)
            n.succ = [k]
            return n
        # Every other statement is straight-line.
        n = self.node(stmt)
        succ: list[Node | None] = [k]
        if ctx.guarded:
            succ.append(ctx.exc)
        n.succ = dedupe(succ)
        return n

    def try_stmt(self, stmt: Any, k: Node, ctx: Ctx) -> Node:
        finalbody = list(getattr(stmt, "finalbody", []) or [])
        handlers = list(getattr(stmt, "handlers", []) or [])
        orelse = list(getattr(stmt, "orelse", []) or [])
        cache: dict[int, Node | None] = {}

        def fin(cont: Node | None) -> Node | None:
            if cont is None:
                return None
            if not finalbody:
                return cont
            if id(cont) in cache:
                return cache[id(cont)]
            fctx = Ctx(ctx.exit, ctx.exc, ctx.brk, ctx.cont, guarded=False)
            entry: Node | None = self.seq(finalbody, cont, fctx)
            cache[id(cont)] = entry
            return entry

        normal_after = fin(k)
        assert normal_after is not None
        if orelse:
            octx = Ctx(fin(ctx.exit), fin(ctx.exc), fin(ctx.brk), fin(ctx.cont), guarded=False)
            body_k = self.seq(orelse, normal_after, octx)
        else:
            body_k = normal_after

        handler_entry: Node | None = self.node(None) if handlers else None
        body_exc = handler_entry if handler_entry is not None else fin(ctx.exc)
        bctx = Ctx(fin(ctx.exit), body_exc, fin(ctx.brk), fin(ctx.cont), guarded=True)
        body_entry = self.seq(stmt.body, body_k, bctx)

        if handler_entry is not None:
            succ: list[Node | None] = []
            catch_all = False
            for handler in handlers:
                htype = getattr(handler, "type", None)
                if htype is None or dotted(htype) in (
                    "Exception",
                    "BaseException",
                    "builtins.Exception",
                    "builtins.BaseException",
                ):
                    catch_all = True
                hctx = Ctx(fin(ctx.exit), fin(ctx.exc), fin(ctx.brk), fin(ctx.cont), guarded=False)
                succ.append(self.seq(handler.body, normal_after, hctx))
            if not catch_all:
                succ.append(fin(ctx.exc))
            handler_entry.succ = dedupe(succ)

        n = self.node(stmt)
        n.succ = [body_entry]
        return n


# ---------------------------------------------------------------------------
# Join recognition
# ---------------------------------------------------------------------------


def awaited_targets(node: ast.AST) -> set[str]:
    """Keys that `await node` waits for; `gather`/`wait` fan out over args."""
    if isinstance(node, ast.Call):
        out: set[str] = set()
        if call_short(node) in GATHER_METHODS:
            for arg in list(node.args) + [kw.value for kw in node.keywords]:
                out |= awaited_targets(arg)
            return out
        return {key_of(node)}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        out = set()
        for elt in node.elts:
            out |= awaited_targets(elt)
        return out
    if isinstance(node, ast.Starred):
        return awaited_targets(node.value)
    if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
        return {key_of(node)}
    return set()


def make_join_predicate(kind: str, target: str, canon: Callable[[str], str]):
    """Build the predicate that recognizes a dominating join on `target`."""

    if kind == "thread":

        def predicate(node: ast.AST) -> bool:
            if not isinstance(node, ast.Call):
                return False
            func = node.func
            if not isinstance(func, ast.Attribute) or func.attr != "join":
                return False
            return canon(receiver_key(func.value)) == target

        return predicate

    def awaited(node: ast.AST) -> bool:
        if not isinstance(node, ast.Await):
            return False
        return target in {canon(k) for k in awaited_targets(node.value)}

    return awaited


def unconditional_join(stmt: ast.stmt, predicate: Callable[[ast.AST], bool]) -> bool:
    """True when `predicate` holds for a node stmt evaluates unconditionally."""

    def walk(node: ast.AST) -> bool:
        if type(node) in _CONDITIONAL:
            return False
        if predicate(node):
            return True
        for child in ast.iter_child_nodes(node):
            if walk(child):
                return True
        return False

    return walk(stmt)


def dominated(node: Node, joins: set[Node]) -> bool:
    """True when no path from node reaches an exit without passing a join."""
    if node in joins:
        return True
    seen = {node}
    stack = [node]
    while stack:
        cur = stack.pop()
        for nxt in cur.succ:
            if nxt in joins or nxt in seen:
                continue
            if nxt.kind == "exit":
                return False
            seen.add(nxt)
            stack.append(nxt)
    return True


# ---------------------------------------------------------------------------
# Scope walking
# ---------------------------------------------------------------------------


def iter_scope(stmts: list[ast.stmt]):
    """Yield every node of a scope; nested defs and class bodies are leaves."""
    stack: list[ast.AST] = list(stmts)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for child in ast.iter_child_nodes(node):
            stack.append(child)


def enclosing_stmt(node: ast.AST) -> ast.stmt | None:
    cur: ast.AST | None = node
    while cur is not None:
        if isinstance(cur, ast.stmt):
            return cur
        cur = getattr(cur, "parent", None)
    return None


def enclosing_has(node: ast.AST, pred: Callable[[ast.AST], bool]) -> bool:
    cur: ast.AST | None = getattr(node, "parent", None)
    while cur is not None:
        if pred(cur):
            return True
        cur = getattr(cur, "parent", None)
    return False


def binding_target(call: ast.AST) -> str:
    """The key a launch handle is bound to: an assignment, annotation or walrus
    whose value is the call itself."""
    cur: ast.AST | None = getattr(call, "parent", None)
    while cur is not None:
        if isinstance(cur, ast.Assign) and len(cur.targets) == 1 and cur.value is call:
            return key_of(cur.targets[0])
        if isinstance(cur, ast.AnnAssign) and cur.value is call:
            return key_of(cur.target)
        if isinstance(cur, ast.NamedExpr) and cur.value is call:
            return key_of(cur.target)
        if isinstance(cur, ast.stmt):
            return ""
        cur = getattr(cur, "parent", None)
    return ""


def aggregate_kinds(value: ast.AST, is_thread: Callable[[ast.AST], bool]) -> str | None:
    """The kind of a launch aggregate, or None when the value holds no launch."""
    if isinstance(value, (ast.Tuple, ast.List)):
        elements: list[ast.AST] = list(value.elts)
    elif isinstance(value, ast.Dict):
        elements = [v for v in value.values if v is not None]
    else:
        return None
    for elt in elements:
        if is_thread(elt):
            return "thread"
        if isinstance(elt, ast.Call) and call_short(elt) in TASK_METHODS:
            return "task"
        if isinstance(elt, ast.Call) and call_short(elt) in OFFLOAD_METHODS:
            return "offload"
    return None


def collect_bindings(
    stmts: list[ast.stmt], imports: Imports, seed: dict[str, str] | None = None
) -> tuple[dict[str, str], Callable[[str], str], set[str]]:
    """Map key -> kind ('thread' | 'task' | 'offload'), with aliases resolved.

    Also returns the names bound to an aggregate (a list, tuple or dict holding a
    launch handle), so a `for` over one of them starts a thread the guard can
    still track.

    `seed` carries the file-wide attribute, container-element and module-level
    bindings from `collect_container_bindings`; every binding this scope makes
    itself, of any form, is layered on top.
    """
    pairs: list[tuple[ast.AST, ast.AST]] = []
    for node in iter_scope(stmts):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                pairs.append((tgt, node.value))
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            pairs.append((node.target, node.value))
        elif isinstance(node, ast.NamedExpr):
            pairs.append((node.target, node.value))

    kinds: dict[str, str] = dict(seed) if seed else {}
    alias: dict[str, str] = {}
    aggregates: set[str] = set()

    def resolve(k: str) -> str:
        seen: set[str] = set()
        while k in alias and k not in seen:
            seen.add(k)
            k = alias[k]
        return k

    for tgt, value in pairs:
        # A tuple/list on both sides binds element-wise, so `t1, t2 = T(), T()`
        # registers both handles.
        if (
            isinstance(tgt, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(tgt.elts) == len(value.elts)
        ):
            for sub_tgt, sub_value in zip(tgt.elts, value.elts):
                if imports.is_thread_ctor(sub_value):
                    kinds[key_of(sub_tgt)] = "thread"
                elif isinstance(sub_value, ast.Call) and call_short(sub_value) in TASK_METHODS:
                    kinds[key_of(sub_tgt)] = "task"
                elif isinstance(sub_value, ast.Call) and call_short(sub_value) in OFFLOAD_METHODS:
                    kinds[key_of(sub_tgt)] = "offload"
            continue
        if imports.is_thread_ctor(value):
            kinds[key_of(tgt)] = "thread"
        elif isinstance(value, ast.Call) and call_short(value) in TASK_METHODS:
            kinds[key_of(tgt)] = "task"
        elif isinstance(value, ast.Call) and call_short(value) in OFFLOAD_METHODS:
            kinds[key_of(tgt)] = "offload"
        elif aggregate_kinds(value, imports.is_thread_ctor) is not None:
            for name in _names_of(tgt):
                aggregates.add(name)

    for _ in range(32):
        changed = False
        for tgt, value in pairs:
            if not isinstance(value, (ast.Name, ast.Attribute, ast.Subscript)):
                continue
            src = resolve(key_of(value))
            if src not in kinds:
                continue
            tk = key_of(tgt)
            if resolve(tk) == src:
                continue
            alias[tk] = src
            kinds[tk] = kinds[src]
            changed = True
        if not changed:
            break

    return kinds, resolve, aggregates


def _names_of(tgt: ast.AST) -> list[str]:
    if isinstance(tgt, ast.Name):
        return [tgt.id]
    if isinstance(tgt, (ast.Tuple, ast.List)):
        out: list[str] = []
        for elt in tgt.elts:
            out.extend(_names_of(elt))
        return out
    return [key_of(tgt)]


def collect_container_bindings(
    tree: ast.Module, imports: Imports
) -> tuple[dict[str, str], dict[str, str], set[str]]:
    """The file-wide launch bindings that outlive the frame that made them.

    Returns `(kinds, containers, daemons)`:

      kinds       key -> kind for an attribute (`self.worker`), a container
                  element (`self.pool["a"]`), a module global, and a class
                  attribute (also under `self.<name>` and `<Class>.<name>`).
      containers  key -> kind for a container that holds a launch, so a subscript
                  whose key the proof cannot match is still recognized.
      daemons     the seeded keys whose constructor carried `daemon=True`, so the
                  report keeps the daemon rule's name in every scope.

    An attribute or a container element belongs to the instance or the container,
    not to the frame that assigned it, so both are collected file-wide. A plain
    name is collected only at module and class-body level, where it is a module
    global or a class attribute rather than a local: a name bound inside one
    function is not assumed to be the same object in another.
    """
    kinds: dict[str, str] = {}
    containers: dict[str, str] = {}
    daemons: set[str] = set()

    def collect(assignments: list[tuple[list[ast.AST], ast.AST]], class_name: str | None) -> None:
        """`class_name` is None outside a module or class body, "" in the module
        body, and the class name inside a class body."""

        def key_of_target(tgt: ast.AST) -> str | None:
            if isinstance(tgt, (ast.Attribute, ast.Subscript)):
                return key_of(tgt)
            if isinstance(tgt, ast.Name) and class_name is not None:
                return tgt.id
            return None

        for targets, value in assignments:
            kind = construct_kind(value, imports)
            if kind is None:
                aggregate = aggregate_kinds(value, imports.is_thread_ctor)
                if aggregate is None:
                    continue
                for tgt in targets:
                    key = key_of_target(tgt)
                    if key is not None:
                        containers[key] = aggregate
                continue
            is_daemon = imports.is_thread_ctor(value) and _ctor_is_daemon(value)
            for tgt in targets:
                key = key_of_target(tgt)
                if key is None:
                    continue
                if isinstance(tgt, ast.Subscript):
                    containers[container_key(tgt)] = kind
                bound = [key]
                if isinstance(tgt, ast.Name) and class_name:
                    # A class attribute is reachable as `self.<name>` and
                    # `<Class>.<name>` from every scope that names it.
                    bound += ["self." + key, f"{class_name}.{key}"]
                for name in bound:
                    kinds[name] = kind
                    if is_daemon:
                        daemons.add(name)

    every_assignment: list[tuple[list[ast.AST], ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            every_assignment.append((node.targets, node.value))
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            every_assignment.append(([node.target], node.value))
    collect(every_assignment, None)

    for body, class_name in [(tree.body, "")] + [
        (node.body, node.name) for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
    ]:
        statements: list[tuple[list[ast.AST], ast.AST]] = []
        for stmt in body:
            if isinstance(stmt, ast.Assign):
                statements.append((stmt.targets, stmt.value))
            elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
                statements.append(([stmt.target], stmt.value))
        collect(statements, class_name)
    return kinds, containers, daemons


# ---------------------------------------------------------------------------
# Scope analysis
# ---------------------------------------------------------------------------


def source_line(lines: list[str], lineno: int) -> str:
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1].strip()
    return ""


def analyze_scope(
    graph: Graph,
    body: list[ast.stmt],
    imports: Imports,
    seed: dict[str, str] | None = None,
    containers: dict[str, str] | None = None,
    daemons: set[str] | None = None,
    signature: bool = False,
) -> list[tuple[int, str]]:
    kinds, canon, aggregates = collect_bindings(body, imports, seed)
    containers = containers or {}
    scope_nodes = list(iter_scope(body))
    statements = [n for n in scope_nodes if isinstance(n, ast.stmt)]
    calls = [n for n in scope_nodes if isinstance(n, ast.Call)]
    findings: list[tuple[int, str]] = []

    def launch_joined(stmt: ast.stmt | None, kind: str, target: str) -> bool:
        if stmt is None or target == "":
            return False
        nodes = graph.nodes_of_stmt.get(id(stmt), [])
        if not nodes:
            return False
        predicate = make_join_predicate(kind, canon(target), canon)
        joins: set[Node] = set()
        for s in statements:
            if isinstance(s, _COMPOUND):
                continue
            if unconditional_join(s, predicate):
                joins.update(graph.nodes_of_stmt.get(id(s), []))
        return all(dominated(n, joins) for n in nodes)

    def container_holds(receiver: ast.AST, kind: str) -> bool:
        """True when a subscript receiver reads a container that holds a launch.

        `pool[key].start()` cannot be matched to a binding by key, so a container
        the proof knows holds a launch is treated conservatively: the read is a
        launch of that kind, reported unless a join names the same textual key.
        """
        if not isinstance(receiver, ast.Subscript):
            return False
        key = canon(container_key(receiver))
        return containers.get(key) == kind or key in aggregates

    def thread_start(call: ast.Call) -> None:
        """Classify one `<receiver>.start()` call."""
        func = call.func
        if not isinstance(func, ast.Attribute):
            return
        receiver = func.value
        if imports.is_thread_ctor(receiver):
            # An inline `Thread(...).start()` discards the handle, so it can
            # never be joined.
            rule = "daemon-thread" if _ctor_is_daemon(receiver) else "thread-start"
            findings.append((call.lineno, rule))
            return
        target = canon(receiver_key(receiver))
        if kinds.get(target) != "thread" and not container_holds(receiver, "thread"):
            return
        if not launch_joined(enclosing_stmt(call), "thread", target):
            rule = "daemon-thread" if target in daemon_threads else "thread-start"
            findings.append((call.lineno, rule))

    # Threads that are started: the daemon flag only makes the report louder, and
    # the guard still reports the thread unless a join dominates.
    daemon_threads: set[str] = {canon(key) for key in (daemons or set())}
    for node in scope_nodes:
        if isinstance(node, ast.Call) and imports.is_thread_ctor(node):
            if _ctor_is_daemon(node):
                tgt = binding_target(node) or key_of(node)
                daemon_threads.add(canon(tgt))
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            tgt = node.targets[0]
            if isinstance(tgt, ast.Attribute) and tgt.attr == "daemon" and is_true_literal(node.value):
                daemon_threads.add(canon(key_of(tgt.value)))

    # A thread reached through a `for` over an aggregate of threads keeps the
    # tracked kind, so its `.start()` is classified by the loop variable. This
    # runs before the call sweep so the loop variable is known when it is met.
    for node in scope_nodes:
        if not isinstance(node, (ast.For, ast.AsyncFor)):
            continue
        if not isinstance(node.target, ast.Name) or not isinstance(node.iter, ast.Name):
            continue
        if node.iter.id not in aggregates:
            continue
        kinds[node.target.id] = "thread"

    for call in calls:
        func = call.func
        attr = func.attr if isinstance(func, ast.Attribute) else None
        short = call_short(call)

        if imports.is_thread_ctor(call):
            if enclosing_has(call, lambda n: isinstance(n, _COMPREHENSIONS)):
                findings.append((call.lineno, "thread-comprehension"))
            elif signature and _ctor_is_daemon(call):
                # A constructor expression in a default argument, decorator or
                # class base runs where its `def`/`class` statement sits, outside
                # every body the join proof covers: a daemon thread there is
                # reported even without a `.start()`.
                findings.append((call.lineno, "daemon-thread"))
            continue

        if attr == "start":
            thread_start(call)
            continue

        if attr == "submit":
            if enclosing_has(
                call,
                lambda n: isinstance(n, (ast.With, ast.AsyncWith))
                and any(imports.is_executor_ctor(item.context_expr) for item in n.items),
            ):
                continue
            findings.append((call.lineno, "executor-submit"))
            continue

        if short in TASK_METHODS:
            if enclosing_has(call, lambda n: isinstance(n, ast.Await)):
                continue
            stmt = enclosing_stmt(call)
            if not launch_joined(stmt, "task", binding_target(call)):
                findings.append((call.lineno, "asyncio-task"))
            continue

        if short in OFFLOAD_METHODS:
            rule = "asyncio-to-thread" if short == "to_thread" else "run-in-executor"
            if enclosing_has(call, lambda n: isinstance(n, ast.Await)):
                continue
            stmt = enclosing_stmt(call)
            if not launch_joined(stmt, "offload", binding_target(call)):
                findings.append((call.lineno, rule))
            continue

    # `x.daemon = True` marks a thread as not-to-be-waited-for. It is reported
    # only when the thread is actually started.
    for node in scope_nodes:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Attribute) or target.attr != "daemon":
            continue
        if not is_true_literal(node.value):
            continue
        name = canon(key_of(target.value))
        if kinds.get(name) != "thread":
            continue
        if not _is_started(scope_nodes, name):
            continue
        if not launch_joined(_start_stmt(scope_nodes, name), "thread", name):
            findings.append((node.lineno, "daemon-thread"))

    out: list[tuple[int, str]] = []
    seen: set[tuple[int, str]] = set()
    for lineno, rule in sorted(set(findings)):
        if (lineno, rule) in seen:
            continue
        seen.add((lineno, rule))
        out.append((lineno, rule))
    return out


def _ctor_is_daemon(call: ast.AST) -> bool:
    return isinstance(call, ast.Call) and any(
        kw.arg == "daemon" and is_true_literal(kw.value) for kw in call.keywords
    )


def _is_started(nodes: list[ast.AST], name: str) -> bool:
    return _start_stmt(nodes, name) is not None


def _start_stmt(nodes: list[ast.AST], name: str) -> ast.stmt | None:
    for node in nodes:
        if not isinstance(node, ast.Call) or call_short(node) != "start":
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and key_of(func.value) == name:
            return enclosing_stmt(node)
    return None


def scopes_of(
    tree: ast.Module, imports: Imports
) -> list[tuple[list[ast.stmt], str, dict[str, str], set[str], bool]]:
    """Every scope the proof walks: `(body, name, seed, daemons, signature)`.

    The module body, every function body (including async ones), every class
    body, and every constructor-expression position a `def`/`class` statement
    evaluates. A function scope carries the parameter names its own default
    arguments bind, so `def g(t=Thread(...)): t.start()` names a thread in `g`
    and nowhere else.
    """
    scopes: list[tuple[list[ast.stmt], str, dict[str, str], set[str], bool]] = [
        (tree.body, "<module>", {}, set(), False)
    ]
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            seed, daemons, positions = signature_positions(node, imports)
            if positions:
                scopes.append((positions, f"{scope_name(node)}.<signature>", {}, set(), True))
            scopes.append((node.body, scope_name(node), seed, daemons, False))
        elif isinstance(node, ast.ClassDef):
            positions = class_signature_positions(node)
            if positions:
                scopes.append((positions, f"{scope_name(node)}.<signature>", {}, set(), True))
            scopes.append((node.body, f"{scope_name(node)}.<class body>", {}, set(), False))
    return scopes


def signature_positions(
    node: ast.FunctionDef | ast.AsyncFunctionDef, imports: Imports
) -> tuple[dict[str, str], set[str], list[ast.stmt]]:
    """The constructor bindings a `def`'s default arguments make, and the
    one-statement scope of the expressions the statement evaluates.

    A default argument is evaluated where the `def` statement sits, outside the
    body that follows it, so a launch in one cannot be joined. It also names the
    parameter the body receives, so a constructor binding there seeds that body
    and only that body: the name is not a module-level or class-level name.
    """
    args = node.args
    positionals = list(args.posonlyargs) + list(args.args)
    named_defaults = list(
        zip(positionals[len(positionals) - len(args.defaults) :], args.defaults, strict=True)
    )
    named_defaults += [
        (arg, default)
        for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=True)
        if default is not None
    ]
    seed: dict[str, str] = {}
    daemons: set[str] = set()
    for arg, default in named_defaults:
        kind = construct_kind(default, imports)
        if kind is None:
            continue
        seed[key_of(arg)] = kind
        if imports.is_thread_ctor(default) and _ctor_is_daemon(default):
            daemons.add(key_of(arg))

    positions = [*node.decorator_list, *(default for _, default in named_defaults)]
    return seed, daemons, [_expression_statement(position) for position in positions]


def class_signature_positions(node: ast.ClassDef) -> list[ast.stmt]:
    """The one-statement scope of a class statement's decorators, bases and
    keywords, which all run where the `class` statement sits."""
    positions = [*node.decorator_list, *node.bases, *(kw.value for kw in node.keywords)]
    return [_expression_statement(position) for position in positions]


def _expression_statement(position: ast.AST) -> ast.stmt:
    """Wrap an expression a `def`/`class` statement evaluates as its own
    statement, so the launch rules run on it in its own scope."""
    synthetic = ast.Expr(value=position)
    ast.copy_location(synthetic, position)
    return synthetic


def scope_name(node: ast.AST) -> str:
    """The qualified name of a function scope: `Class.method`, `outer.inner`."""
    names = [node.name]
    cur = getattr(node, "parent", None)
    while cur is not None:
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.insert(0, cur.name)
        elif isinstance(cur, ast.ClassDef):
            names.insert(0, cur.name)
            break
        cur = getattr(cur, "parent", None)
    return ".".join(names)


def attach_parents(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node
    return tree


def scan_file(path: str, source: str) -> dict[str, Any]:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as err:
        return {"path": path, "findings": [], "error": f"SyntaxError: {err}"}
    attach_parents(tree)
    lines = source.splitlines()
    imports = collect_imports(tree)
    seeded, containers, daemons = collect_container_bindings(tree, imports)
    findings: list[dict[str, Any]] = []
    for body, name, seed, scope_daemons, signature in scopes_of(tree, imports):
        graph = Graph()
        graph.seq(body, graph.exit, Ctx(graph.exit, graph.exit))
        scope_seed = dict(seeded)
        scope_seed.update(seed)
        for lineno, rule in analyze_scope(
            graph,
            body,
            imports,
            seed=scope_seed,
            containers=containers,
            daemons=daemons | scope_daemons,
            signature=signature,
        ):
            findings.append(
                {
                    "line": lineno,
                    "rule": rule,
                    "scope": name,
                    "text": source_line(lines, lineno),
                }
            )
    findings.sort(key=lambda f: (f["line"], f["rule"], f["scope"]))
    seen: set[tuple[int, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for f in findings:
        key = (f["line"], f["rule"], f["scope"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(f)
    return {"path": path, "findings": unique, "error": None}


def main() -> int:
    request = json.load(sys.stdin)
    results = [
        scan_file(str(e.get("path", "<memory>")), str(e.get("source", "")))
        for e in request.get("files", [])
    ]
    json.dump({"results": results}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
