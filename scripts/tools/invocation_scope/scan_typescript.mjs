#!/usr/bin/env node
/*
 * AST invocation-scope scanner for TypeScript/JavaScript sources.
 *
 * Invoked by scripts/tools/invocation_scope (the repository guard), which
 * scripts/verify-invocation-scope.sh runs — with this scanner and the guard's
 * self-tests — as part of `make rubric`. `make test-unit` is `go test` only and
 * never invokes this scanner, so the sweep is pinned by the rubric verifier and
 * not by the unit-test target.
 * It uses the TypeScript compiler API from ts/node_modules/typescript, which is
 * already a devDependency of ts/.
 *
 * Protocol (one request/response per process):
 *
 *   request  := {"files": [{"path": "<repo-relative>", "source": "<text>"}]}
 *   response := {"results": [{"path": ..., "findings": [
 *                   {"line": <1-based>, "rule": "<rule>", "scope": "<enclosing scope>",
 *                    "text": "<source line>"}
 *               ], "error": null | "<message>"}]}
 *
 * Proof, exactly: a launch is reported unless a join on the same target executes
 * on every path from the launch to every exit of the scope that contains it. The
 * source is parsed with the TypeScript compiler; each scope (the file's top
 * level, every function-like node, every parameter initializer, every class
 * property initializer and every static block) gets a control-flow graph whose
 * nodes are statements and whose edges are fallthrough, branches, loop
 * back-edges, break/continue targets, and exception transfers into catch/finally
 * clauses. `return` and an unhandled `throw` are exits; a nested function is an
 * opaque statement, so its `return` is not this scope's exit and its `await` is
 * not this scope's join.
 *
 * A launch is accepted only when no path from its statement to an exit avoids
 * every join statement, where a join statement is one that executes the join
 * unconditionally whenever it executes: an `await` (or `return`) of the held
 * target, `await Promise.all/allSettled/race/any(...)` over it, or a
 * clearTimeout/clearInterval/clearImmediate of a timer handle. The target and the
 * join are matched on the bare expression, so a non-null assertion, a type
 * assertion and parentheses around either name the same target
 * (`clearTimeout(this.t!)` clears the `this.t` a `this.t = setTimeout(...)` armed).
 * A join nested in an `if` branch, a loop body, a `try` body without a joining
 * `finally`, a nested arrow/function, a conditional expression (`c ? a : b`), or a
 * short-circuit operator (`c && a`, `c || a`, `a ?? b`) is not such a statement,
 * so `if (c) await p;`, `c && await p;` and `c ? await p : 0` leave the held
 * target reported. A join in a `finally` clause is reached from every exit and so
 * dominates; a join split across both branches of an `if/else` is accepted,
 * because the graph merges the branches.
 *
 * Recognized launches: timers (`setTimeout`/`setInterval`/`setImmediate`, property
 * or computed-member form, and a timer function the file binds to a variable —
 * `const st = setTimeout; st(cb, 1)`) that no clear on every path releases;
 * `queueMicrotask` and `process.nextTick`; an iterator read held from
 * `<expr>.next()`, which starts the producer's next step and must settle first; a
 * `void` discard of a call; a dropped async IIFE; a dropped `.then`/`.catch`/
 * `.finally` chain; a dropped call to a function this file declares `async` or
 * assigns to a member as an async arrow (`this.run = async () => {...}`); a
 * promise bound to a name, member, element or destructuring pattern and not
 * joined on every path (including `this.x =`, a rebinding `p = ...`, a compound
 * `p ??= ...`, a chained `a = b = ...` and a container element `jobs["a"] = ...`);
 * an array or object aggregate of promises; and an `Array.from(...)`/`.map(...)`
 * given an async callback.
 *
 * Deliberately conservative, and documented as such in
 * docs/features/http-runtime.md:
 *
 *   * Only exceptions raised inside a `try` block are modeled; they transfer to
 *     that statement's `catch` (or its `finally` and then outward). An exception
 *     anywhere else is not an exit, mirroring the Go scanner.
 *   * `switch` cases are modeled without fallthrough, so each case body is
 *     treated as ending the switch.
 *   * `unref()` is not a join: it releases the event loop, not the callback.
 *   * A dropped promise whose producer is only known from types (not syntax) is
 *     left to @typescript-eslint/no-floating-promises inside ts/**.
 *   * An aggregate bound through a destructuring pattern is reported as one
 *     launch on the whole pattern, so a join has to cover every bound name.
 *   * A parameter initializer is reported whenever it launches: it runs when the
 *     call is made, before any join in the body that could release it, so the
 *     proof does not credit a body `await` to a default-argument launch.
 *   * A timer alias is collected file-wide, so a local binding of a timer name
 *     (`const st = setTimeout`) makes a later `st(...)` a launch in every scope of
 *     the file. The broader tracking errs toward reporting.
 *   * A member-assigned async method is matched by name, not by receiver: a
 *     `this.run = async () => {...}` anywhere in the file makes any
 *     `<receiver>.run()` a launch.
 *   * A join is matched on the bare held target, not through a chain that
 *     consumes it: `await p.then(f)` is not read as a join of `p`, so a launch
 *     whose only release is a chain on it is reported.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

let ts;
try {
  const requireFromTs = createRequire(path.join(REPO_ROOT, 'ts', 'package.json'));
  ts = requireFromTs('typescript');
} catch (err) {
  process.stderr.write(`scan_typescript: cannot load the TypeScript compiler (${err})\n`);
  process.exit(2);
}

const TIMER_NAMES = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const CLEAR_NAMES = new Set(['clearTimeout', 'clearInterval', 'clearImmediate']);
const CHAIN_NAMES = new Set(['then', 'catch', 'finally']);
const RESOLVER_NAMES = new Set(['resolve', 'r', 'res', 'done', 'reject', '_resolve', '_r']);
const PROMISE_STATIC_NAMES = new Set(['all', 'allSettled', 'race', 'any']);
const ASYNC_CALLBACK_METHODS = new Set([
  'map',
  'filter',
  'forEach',
  'flatMap',
  'reduce',
  'from',
  'some',
  'every',
  'find',
]);

const STOP_KINDS = new Set([
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.Block,
]);

const FUNC_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

const COMPOUND_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.Block,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
]);

const ASSIGN_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
]);

function isAssignmentOperator(kind) {
  return ASSIGN_OPERATORS.has(kind);
}

function isFunctionLike(node) {
  return FUNC_LIKE_KINDS.has(node.kind);
}

function isClassLike(node) {
  return (
    node.kind === ts.SyntaxKind.ClassDeclaration ||
    node.kind === ts.SyntaxKind.ClassExpression ||
    node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration
  );
}

function hasAsync(node) {
  const mods = node.modifiers;
  return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function skipParens(node) {
  let cur = node;
  while (cur && ts.isParenthesizedExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

// bareText is the text a held target is matched on: the assertion wrappers that
// do not change which value is named are stripped, so `this.t!`, `this.t as
// Timer`, `(this.t)` and `this.t` are one target.
function bareText(file, node) {
  let cur = node;
  for (;;) {
    if (!cur) {
      return '';
    }
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(cur))
    ) {
      cur = cur.expression;
      continue;
    }
    return cur.getText(file);
  }
}

function memberInfo(node) {
  const expr = skipParens(node);
  if (!expr) {
    return null;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return { name: expr.name.text, receiver: expr.expression };
  }
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      return { name: arg.text, receiver: expr.expression };
    }
  }
  return null;
}

function calleeName(node) {
  const expr = skipParens(node);
  if (!expr) {
    return null;
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  const info = memberInfo(expr);
  return info ? info.name : null;
}

function isAsyncFunctionExpression(node) {
  const expr = skipParens(node);
  return (
    !!expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) && hasAsync(expr)
  );
}

function walkAll(node, cb) {
  cb(node);
  ts.forEachChild(node, (child) => walkAll(child, cb));
}

// ---------------------------------------------------------------------------
// Control-flow graph
// ---------------------------------------------------------------------------

class GNode {
  constructor(stmt) {
    this.succ = [];
    this.stmt = stmt ?? null;
    this.kind = 'plain';
  }
}

class Ctx {
  constructor(exit, exc, brk, cont, guarded) {
    this.exit = exit;
    this.exc = exc;
    this.brk = brk;
    this.cont = cont;
    this.guarded = guarded;
  }
}

function dedupe(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n && !out.includes(n)) {
      out.push(n);
    }
  }
  return out;
}

class Graph {
  constructor() {
    this.exit = new GNode();
    this.exit.kind = 'exit';
    this.nodesOfStmt = new Map();
  }

  node(stmt) {
    const n = new GNode(stmt);
    if (stmt) {
      const list = this.nodesOfStmt.get(stmt) ?? [];
      list.push(n);
      this.nodesOfStmt.set(stmt, list);
    }
    return n;
  }

  seq(stmts, k, ctx) {
    let entry = k;
    for (let i = stmts.length - 1; i >= 0; i -= 1) {
      entry = this.stmt(stmts[i], entry, ctx);
    }
    return entry;
  }

  stmt(s, k, ctx) {
    if (s.kind === ts.SyntaxKind.ReturnStatement) {
      const n = this.node(s);
      n.succ = dedupe([ctx.exit]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.ThrowStatement) {
      const n = this.node(s);
      n.succ = dedupe([ctx.exc]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.BreakStatement) {
      const n = this.node(s);
      n.succ = dedupe([s.label ? ctx.exit : ctx.brk]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.ContinueStatement) {
      const n = this.node(s);
      n.succ = dedupe([s.label ? ctx.exit : ctx.cont]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.Block) {
      return this.seq(s.statements, k, ctx);
    }
    if (s.kind === ts.SyntaxKind.IfStatement) {
      const n = this.node(s);
      const thenE = this.stmt(s.thenStatement, k, ctx);
      const elseE = s.elseStatement ? this.stmt(s.elseStatement, k, ctx) : k;
      n.succ = dedupe([thenE, elseE]);
      return n;
    }
    if (
      s.kind === ts.SyntaxKind.WhileStatement ||
      s.kind === ts.SyntaxKind.ForStatement ||
      s.kind === ts.SyntaxKind.ForInStatement ||
      s.kind === ts.SyntaxKind.ForOfStatement
    ) {
      const n = this.node(s);
      const bodyCtx = new Ctx(ctx.exit, ctx.exc, k, n, ctx.guarded);
      const bodyE = this.stmt(s.statement, n, bodyCtx);
      n.succ = dedupe([bodyE, k]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.DoStatement) {
      const n = this.node(s);
      const bodyCtx = new Ctx(ctx.exit, ctx.exc, k, n, ctx.guarded);
      const bodyE = this.stmt(s.statement, n, bodyCtx);
      n.succ = dedupe([bodyE, k]);
      return bodyE;
    }
    if (s.kind === ts.SyntaxKind.SwitchStatement) {
      const n = this.node(s);
      const brkCtx = new Ctx(ctx.exit, ctx.exc, k, ctx.cont, ctx.guarded);
      const entries = [];
      for (const clause of s.caseBlock.clauses) {
        entries.push(this.seq(clause.statements, k, brkCtx));
      }
      n.succ = dedupe([...entries, k]);
      return n;
    }
    if (s.kind === ts.SyntaxKind.TryStatement) {
      return this.tryStmt(s, k, ctx);
    }
    if (s.kind === ts.SyntaxKind.LabeledStatement) {
      return this.stmt(s.statement, k, ctx);
    }
    if (s.kind === ts.SyntaxKind.FunctionDeclaration || s.kind === ts.SyntaxKind.ClassDeclaration) {
      const n = this.node(s);
      n.succ = [k];
      return n;
    }
    const n = this.node(s);
    const succ = [k];
    if (ctx.guarded) {
      succ.push(ctx.exc);
    }
    n.succ = dedupe(succ);
    return n;
  }

  tryStmt(s, k, ctx) {
    const finalStmts = s.finallyBlock ? s.finallyBlock.statements : null;
    const cache = new Map();
    const fin = (cont) => {
      if (!cont) {
        return null;
      }
      if (!finalStmts) {
        return cont;
      }
      if (cache.has(cont)) {
        return cache.get(cont);
      }
      const fctx = new Ctx(ctx.exit, ctx.exc, ctx.brk, ctx.cont, false);
      const entry = this.seq(finalStmts, cont, fctx);
      cache.set(cont, entry);
      return entry;
    };
    const normalAfter = fin(k);
    const catchEntry = s.catchClause ? this.node(null) : null;
    const tryExc = catchEntry ?? fin(ctx.exc);
    const tctx = new Ctx(fin(ctx.exit), tryExc, fin(ctx.brk), fin(ctx.cont), true);
    const tryEntry = this.seq(s.tryBlock.statements, normalAfter, tctx);
    if (catchEntry) {
      const cctx = new Ctx(fin(ctx.exit), fin(ctx.exc), fin(ctx.brk), fin(ctx.cont), false);
      catchEntry.succ = dedupe([this.seq(s.catchClause.block.statements, normalAfter, cctx)]);
    }
    const n = this.node(s);
    n.succ = [tryEntry];
    return n;
  }
}

// ---------------------------------------------------------------------------
// Join recognition
// ---------------------------------------------------------------------------

// joinedKeys lists the held targets one join expression releases. `Promise.all`,
// `allSettled`, `race` and `any` fan out over their arguments; an array literal
// or a tuple literal passes through. Anything else is its own key.
function joinedKeys(file, expr, out) {
  if (!expr) {
    return out;
  }
  const node = skipParens(expr);
  if (node && ts.isCallExpression(node)) {
    const info = memberInfo(node.expression);
    const name = info ? info.name : null;
    const receiverText = info ? info.receiver.getText(file) : '';
    if (name && PROMISE_STATIC_NAMES.has(name) && receiverText === 'Promise') {
      for (const arg of node.arguments) {
        joinedKeys(file, arg, out);
      }
      return out;
    }
  }
  if (node && (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node))) {
    for (const el of ts.isArrayLiteralExpression(node) ? node.elements : node.properties) {
      joinedKeys(file, ts.isPropertyAssignment(el) ? el.initializer : el, out);
    }
    return out;
  }
  if (node && ts.isSpreadElement(node)) {
    return joinedKeys(file, node.expression, out);
  }
  out.add(bareText(file, expr));
  return out;
}

// makeJoinPredicate recognizes a statement or expression that releases target.
// A timer handle is released by a clear call; a promise is released by awaiting
// or returning it (or by awaiting a Promise.all/allSettled/race/any over it).
function makeJoinPredicate(file, target, isTimer) {
  return (node) => {
    if (isTimer) {
      if (ts.isCallExpression(node)) {
        const info = memberInfo(node.expression);
        const name = info ? info.name : calleeName(node.expression);
        if (name && CLEAR_NAMES.has(name)) {
          return node.arguments.some((arg) => bareText(file, arg) === target);
        }
      }
      return false;
    }
    if (ts.isAwaitExpression(node)) {
      return joinedKeys(file, node.expression, new Set()).has(target);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      return joinedKeys(file, node.expression, new Set()).has(target);
    }
    return false;
  };
}

function unconditionalJoin(stmt, predicate) {
  const walk = (node) => {
    if (STOP_KINDS.has(node.kind)) {
      return false;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return false;
      }
    }
    if (predicate(node)) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && walk(child)) {
        found = true;
      }
    });
    return found;
  };
  return walk(stmt);
}

function dominates(node, joins) {
  if (joins.has(node)) {
    return true;
  }
  const seen = new Set([node]);
  const stack = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const next of cur.succ) {
      if (joins.has(next) || seen.has(next)) {
        continue;
      }
      if (next.kind === 'exit') {
        return false;
      }
      seen.add(next);
      stack.push(next);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scope gathering and naming
// ---------------------------------------------------------------------------

function classNameOf(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.kind === ts.SyntaxKind.ClassDeclaration ||
      cur.kind === ts.SyntaxKind.ClassExpression
    ) {
      return cur.name ? cur.name.text : '<anonymous class>';
    }
    cur = cur.parent;
  }
  return '';
}

// ownScopeName names a scope from the node that declares it, or "" when the node
// is anonymous and has to borrow its enclosing name.
function ownScopeName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return `${classNameOf(node)}.${node.name.getText()}`;
  }
  if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return `${classNameOf(node)}.${node.name.getText()}`;
  }
  if (ts.isConstructorDeclaration(node)) {
    return `${classNameOf(node)}.constructor`;
  }
  if (ts.isPropertyDeclaration(node) && node.name) {
    return `${classNameOf(node)}.${node.name.getText()}`;
  }
  if (ts.isClassStaticBlockDeclaration(node)) {
    return `${classNameOf(node)}.<static block>`;
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return parent.name.getText();
  }
  if (parent && ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return parent.name.getText();
  }
  return '';
}

function enclosingNamedScope(node) {
  let cur = node.parent;
  while (cur) {
    if (cur !== node && isFunctionLike(cur)) {
      const name = ownScopeName(cur);
      if (name) {
        return name;
      }
    }
    cur = cur.parent;
  }
  return '<module>';
}

function scopeName(node) {
  const own = ownScopeName(node);
  if (own) {
    return own;
  }
  return `${enclosingNamedScope(node)}.<anonymous>`;
}

function collectScopes(file) {
  const scopes = [{ root: file, stmts: file.statements, name: '<module>' }];
  walkAll(file, (node) => {
    if (node === file) {
      return;
    }
    if (isFunctionLike(node)) {
      // A parameter initializer runs when the call is made, before any join the
      // body could reach, so it is a scope of its own.
      const params = (node.parameters ?? []).filter(
        (param) => ts.isParameter(param) && param.initializer,
      );
      if (params.length > 0) {
        scopes.push({
          root: node,
          stmts: [],
          params,
          name: `${scopeName(node)}.<parameter default>`,
        });
      }
      if (node.body && ts.isBlock(node.body)) {
        scopes.push({ root: node, stmts: node.body.statements, name: scopeName(node) });
      }
      return;
    }
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      scopes.push({ root: node, field: node, name: scopeName(node) });
      return;
    }
    if (ts.isClassStaticBlockDeclaration(node)) {
      scopes.push({ root: node, stmts: node.body.statements, name: scopeName(node) });
    }
  });
  return scopes;
}

function collectInScope(stmts) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    if (isFunctionLike(node) || isClassLike(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const s of stmts) {
    visit(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Launch classification
// ---------------------------------------------------------------------------

function promiseRule(file, expr, asyncNames, timerAliases) {
  const node = skipParens(expr);
  if (!node) {
    return null;
  }
  if (ts.isVoidExpression(node)) {
    const inner = skipParens(node.expression);
    return inner && ts.isCallExpression(inner) ? 'void-call' : null;
  }
  if (ts.isCallExpression(node)) {
    if (isAsyncFunctionExpression(node.expression)) {
      return 'detached-async-iife';
    }
    const info = memberInfo(node.expression);
    const name = info ? info.name : calleeName(node.expression);
    if (info && CHAIN_NAMES.has(info.name)) {
      return `floating-${info.name}`;
    }
    if (name === 'queueMicrotask') {
      return 'queue-microtask';
    }
    if (info && info.name === 'nextTick' && info.receiver.getText(file) === 'process') {
      return 'process-next-tick';
    }
    const timerName = timerNameOf(name, timerAliases);
    if (timerName) {
      const first = skipParens(node.arguments[0]);
      if (first && ts.isIdentifier(first) && RESOLVER_NAMES.has(first.text)) {
        // `setTimeout(resolve, ms)` is the promise-delay idiom, not detached work.
        return null;
      }
      return `timer-${timerName}`;
    }
    if (info && info.name === 'next') {
      // A held iterator read starts the producer's next step. Its promise has to
      // settle before the invocation returns, so it is a launch whether or not
      // the chain that consumes it is awaited.
      return 'async-read';
    }
    if (name && asyncNames.has(name)) {
      return 'discarded-async-call';
    }
    if (info && PROMISE_STATIC_NAMES.has(info.name) && info.receiver.getText(file) === 'Promise') {
      return 'floating-promise';
    }
    if (name && ASYNC_CALLBACK_METHODS.has(name) && node.arguments.some(isAsyncFunctionExpression)) {
      return 'floating-promise';
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    return aggregateRule(file, node, asyncNames, timerAliases);
  }
  return null;
}

// aggregateRule recognizes an array or object literal that holds a launch, so a
// binding of the aggregate is a launch of everything inside it.
function aggregateRule(file, node, asyncNames, timerAliases) {
  let found = false;
  const visit = (child) => {
    if (found) {
      return;
    }
    if (isFunctionLike(child)) {
      return;
    }
    if (ts.isCallExpression(child) && promiseRule(file, child, asyncNames, timerAliases)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found ? 'floating-promise' : null;
}

function asyncFunctionNames(file) {
  const names = new Set();
  walkAll(file, (node) => {
    // An async generator returns an AsyncGenerator, not a pending promise: it
    // runs only when something iterates it, so its call is not detached work.
    if (
      ts.isFunctionDeclaration(node) &&
      hasAsync(node) &&
      !node.asteriskToken &&
      node.name
    ) {
      names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isAsyncFunctionExpression(node.initializer)) {
      if (ts.isIdentifier(node.name) && !skipParens(node.initializer).asteriskToken) {
        names.add(node.name.text);
      }
    }
    // A class field's async arrow is an async method of the instance, the same
    // way a member assignment is: `run = async () => {...}` names `run`.
    if (ts.isPropertyDeclaration(node) && node.initializer && node.name) {
      const initializer = skipParens(node.initializer);
      if (initializer && isAsyncFunctionExpression(initializer) && !initializer.asteriskToken) {
        const info = memberInfo(node.name);
        const name = info ? info.name : calleeName(node.name);
        if (name) {
          names.add(name);
        }
      }
    }
    // A member assigned an async arrow declares an async method too:
    // `this.run = async () => {...}` names `run`, so a later `<receiver>.run()`
    // is a call to a function the file declares async.
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const right = skipParens(node.right);
      if (!right || !isAsyncFunctionExpression(right) || right.asteriskToken) {
        return;
      }
      const left = skipParens(node.left);
      if (ts.isPropertyAccessExpression(left)) {
        names.add(left.name.text);
      } else if (ts.isElementAccessExpression(left)) {
        const arg = left.argumentExpression;
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          names.add(arg.text);
        }
      }
    }
  });
  return names;
}

// timerAliasNames maps a variable the file binds to a timer function onto that
// timer's name, so `const st = setTimeout; st(cb, 1)` is the timer it names.
function timerAliasNames(file) {
  const aliases = new Map();
  walkAll(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) {
      return;
    }
    const init = skipParens(node.initializer);
    if (!init) {
      return;
    }
    if (ts.isIdentifier(init) && TIMER_NAMES.has(init.text)) {
      aliases.set(node.name.text, init.text);
      return;
    }
    const info = memberInfo(init);
    if (info && TIMER_NAMES.has(info.name)) {
      aliases.set(node.name.text, info.name);
    }
  });
  return aliases;
}

// timerNameOf resolves a callee name through the file's timer aliases.
function timerNameOf(name, timerAliases) {
  if (!name) {
    return null;
  }
  if (TIMER_NAMES.has(name)) {
    return name;
  }
  return timerAliases.get(name) ?? null;
}

// targetKeys lists the held targets a binding introduces. A destructuring
// pattern contributes every name it binds.
function targetKeys(node) {
  const out = [];
  const visit = (cur) => {
    if (!cur) {
      return;
    }
    if (ts.isIdentifier(cur)) {
      out.push(cur.text);
      return;
    }
    if (ts.isBindingElement(cur)) {
      visit(cur.name);
      return;
    }
    if (ts.isObjectBindingPattern(cur) || ts.isArrayBindingPattern(cur)) {
      ts.forEachChild(cur, visit);
      return;
    }
  };
  visit(node);
  if (out.length > 0) {
    return out;
  }
  return [bareText(node.getSourceFile(), node)];
}

// ---------------------------------------------------------------------------
// Scope analysis
// ---------------------------------------------------------------------------

const DISCARD = { kind: 'discard' };
const CONSUME = { kind: 'consume' };

function lineOf(node) {
  const pos = node.getStart();
  return node.getSourceFile().getLineAndCharacterOfPosition(pos).line + 1;
}

function statementOf(node) {
  let cur = node;
  while (cur && !ts.isStatement(cur)) {
    cur = cur.parent;
  }
  return cur;
}

function analyzeScope(file, scope, asyncNames, timerAliases) {
  const graph = new Graph();
  let scanStmts = scope.stmts ?? [];
  if (scope.field) {
    const n = graph.node(scope.field);
    n.succ = [graph.exit];
    scanStmts = [scope.field];
  } else {
    graph.seq(scope.stmts, graph.exit, new Ctx(graph.exit, graph.exit, null, null, false));
  }

  const nodes = collectInScope(scanStmts);
  const statements = nodes.filter((n) => ts.isStatement(n) || ts.isPropertyDeclaration(n));
  const found = [];

  const report = (node, rule, ctx) => {
    if (ctx.kind === 'consume') {
      return;
    }
    if (ctx.kind === 'bind' && ctx.targets && ctx.targets.length > 0) {
      found.push({
        line: lineOf(node),
        rule,
        anchor: statementOf(node) ?? node,
        targets: ctx.targets,
        isTimer: rule.startsWith('timer-'),
      });
      return;
    }
    found.push({ line: lineOf(node), rule, anchor: null, targets: null });
  };

  const walkExpr = (node, ctx) => {
    const e = skipParens(node);
    if (!e || ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isFunctionDeclaration(e)) {
      return;
    }
    if (ts.isBinaryExpression(e) && isAssignmentOperator(e.operatorToken.kind)) {
      walkExpr(e.right, { kind: 'bind', targets: targetKeys(e.left) });
      walkExpr(e.left, DISCARD);
      return;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      walkExpr(e.left, DISCARD);
      walkExpr(e.right, ctx);
      return;
    }
    if (ts.isAwaitExpression(e)) {
      walkExpr(e.expression, CONSUME);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      walkExpr(e.condition, CONSUME);
      walkExpr(e.whenTrue, ctx);
      walkExpr(e.whenFalse, ctx);
      return;
    }
    if (ts.isVoidExpression(e)) {
      const inner = skipParens(e.expression);
      if (inner && ts.isCallExpression(inner)) {
        report(inner, promiseRule(file, e, asyncNames, timerAliases) ?? 'void-call', ctx);
        return;
      }
      walkExpr(e.expression, CONSUME);
      return;
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) {
        walkExpr(el, ctx);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const prop of e.properties) {
        if (ts.isPropertyAssignment(prop)) {
          walkExpr(prop.initializer, ctx);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          walkExpr(prop.name, ctx);
        } else if (ts.isSpreadAssignment(prop)) {
          walkExpr(prop.expression, ctx);
        }
      }
      return;
    }
    if (ts.isSpreadElement(e)) {
      walkExpr(e.expression, ctx);
      return;
    }
    const rule = promiseRule(file, e, asyncNames, timerAliases);
    if (rule) {
      report(e, rule, ctx);
      return;
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const consumer = isJoinConsumer(file, e);
      for (const arg of e.arguments ?? []) {
        walkExpr(arg, consumer ? CONSUME : DISCARD);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      walkExpr(e.expression, DISCARD);
      if (ts.isElementAccessExpression(e)) {
        walkExpr(e.argumentExpression, DISCARD);
      }
      return;
    }
    if (ts.isBinaryExpression(e)) {
      walkExpr(e.left, DISCARD);
      walkExpr(e.right, DISCARD);
      return;
    }
    if (ts.isTypeOfExpression(e) || ts.isNonNullExpression(e)) {
      walkExpr(e.expression, ctx);
    }
  };

  const walkDeclList = (declList) => {
    if (!declList) {
      return;
    }
    for (const decl of declList.declarations) {
      if (decl.initializer) {
        walkExpr(decl.initializer, { kind: 'bind', targets: targetKeys(decl.name) });
      }
    }
  };

  // A parameter initializer is evaluated where the call is made, so nothing in
  // this scope joins it: the launch it makes is reported as it is walked.
  for (const param of scope.params ?? []) {
    walkExpr(param.initializer, DISCARD);
  }

  for (const node of nodes) {
    if (ts.isPropertyDeclaration(node)) {
      if (node.initializer) {
        walkExpr(node.initializer, { kind: 'bind', targets: targetKeys(node.name) });
      }
      continue;
    }
    if (!ts.isStatement(node)) {
      continue;
    }
    if (ts.isExpressionStatement(node)) {
      walkExpr(node.expression, DISCARD);
      continue;
    }
    if (ts.isVariableStatement(node)) {
      walkDeclList(node.declarationList);
      continue;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      walkExpr(node.expression, CONSUME);
      continue;
    }
    if (ts.isThrowStatement(node) && node.expression) {
      walkExpr(node.expression, CONSUME);
      continue;
    }
    if (ts.isIfStatement(node)) {
      walkExpr(node.expression, DISCARD);
      continue;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      walkExpr(node.expression, DISCARD);
      continue;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          walkDeclList(node.initializer);
        } else {
          walkExpr(node.initializer, DISCARD);
        }
      }
      walkExpr(node.condition, DISCARD);
      walkExpr(node.incrementor, DISCARD);
      continue;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        walkDeclList(node.initializer);
      }
      walkExpr(node.expression, DISCARD);
      continue;
    }
    if (ts.isSwitchStatement(node)) {
      walkExpr(node.expression, DISCARD);
      continue;
    }
    if (ts.isWithStatement(node)) {
      walkExpr(node.expression, DISCARD);
    }
  }

  // A launch bound to a target is reported unless a join on that target
  // dominates every exit from the launch.
  const launches = statements;
  const joinNodesFor = (target, isTimer) => {
    const predicate = makeJoinPredicate(file, target, isTimer);
    const joins = new Set();
    for (const s of launches) {
      if (COMPOUND_KINDS.has(s.kind)) {
        continue;
      }
      if (unconditionalJoin(s, predicate)) {
        for (const n of graph.nodesOfStmt.get(s) ?? []) {
          joins.add(n);
        }
      }
    }
    return joins;
  };

  const out = [];
  for (const f of found) {
    if (!f.anchor || !f.targets) {
      out.push(f);
      continue;
    }
    const owners = graph.nodesOfStmt.get(f.anchor) ?? [];
    if (owners.length === 0) {
      out.push(f);
      continue;
    }
    const joined = f.targets.every((target) => {
      const joins = joinNodesFor(target, f.isTimer);
      return owners.every((n) => dominates(n, joins));
    });
    if (!joined) {
      out.push(f);
    }
  }
  return out;
}

function isJoinConsumer(file, call) {
  const info = memberInfo(call.expression);
  if (!info) {
    const name = calleeName(call.expression);
    return name === 'all' || name === 'allSettled';
  }
  return (
    PROMISE_STATIC_NAMES.has(info.name) && info.receiver.getText(file) === 'Promise'
  );
}

function sourceLine(lines, lineno) {
  return lineno >= 1 && lineno <= lines.length ? lines[lineno - 1].trim() : '';
}

function scriptKindFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function scanFile(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  if (file.parseDiagnostics && file.parseDiagnostics.length > 0) {
    const rendered = file.parseDiagnostics
      .map((d) => {
        const where = d.start !== undefined ? file.getLineAndCharacterOfPosition(d.start) : null;
        const at = where ? `${where.line + 1}:${where.character + 1}: ` : '';
        return at + ts.flattenDiagnosticMessageText(d.messageText, ' ');
      })
      .join('; ');
    return { path: fileName, findings: [], error: `TypeScript parse error: ${rendered}` };
  }

  const asyncNames = asyncFunctionNames(file);
  const timerAliases = timerAliasNames(file);
  const lines = source.split('\n');
  const findings = [];
  for (const scope of collectScopes(file)) {
    for (const f of analyzeScope(file, scope, asyncNames, timerAliases)) {
      findings.push({
        line: f.line,
        rule: f.rule,
        scope: scope.name,
        text: sourceLine(lines, f.line),
      });
    }
  }
  const seen = new Set();
  const unique = [];
  findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  for (const f of findings) {
    const key = `${f.line}:${f.rule}:${f.scope}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(f);
  }
  return { path: fileName, findings: unique, error: null };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const request = JSON.parse(await readStdin());
const results = [];
for (const entry of request.files ?? []) {
  try {
    results.push(scanFile(String(entry.path ?? '<memory>'), String(entry.source ?? '')));
  } catch (err) {
    results.push({
      path: String(entry.path ?? '<memory>'),
      findings: [],
      error: String(err && err.stack ? err.stack : err),
    });
  }
}
process.stdout.write(`${JSON.stringify({ results })}\n`);
