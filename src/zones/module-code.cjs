"use strict";
/*
 * A Turbopack module factory, read with a JavaScript parser (acorn, the copy Next ships): what Zones needs to know
 * about a client module, exactly.
 *
 * - canonical: the code up to the names of its bindings. Two builds minify one module with different local names, so
 *   identity is alpha-equivalence: every identifier is resolved to the binding it refers to (scopes: functions with
 *   var hoisting, blocks for let/const/class, catch, loops, named function and class expressions, sloppy-mode block
 *   functions, labels, a class's private names), and a bound name is written as the binding's index, in order of
 *   declaration. A free name (a global, `arguments`) is kept. Strings, numbers, regular expressions, templates, property names and the shape of
 *   the code are kept. Equal canonical forms mean the same code. A module using `with` or a direct `eval` (where a
 *   name can be looked up by its text) keeps its names: only its exact text matches.
 * - requires: the module ids it requires: calls on the factory's own context parameter (not a local that shadows
 *   it), a one-letter method, a numeric id: `e.i(123)`. Each with the id literal's position, for remapping. In the
 *   canonical form the id is blanked: a dependency counts by what it is (zone-client.cjs hashes it in).
 * - runtimeMethods: the names the module uses on its context (`e.i(…)`, `e.g`, …), checked against the shell's runtime.
 *
 * This replaces a tokenizer over minified text (debt D15): there, a short name was renamed by first appearance
 * whatever it was bound to, a long local kept its name, and `x.y(1)` on any one-letter object counted as a require.
 */

let acorn = null;
/** The parser: Next's compiled acorn, resolved from the shell (next-contract.cjs checks it is there). */
function useParser(parser) { acorn = parser; }

const FUNCTION = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw", "sourceType", "extra"]);

/** Names a pattern binds (params, declarators, catch params). */
function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier": out.push(pattern); break;
    case "ObjectPattern": for (const p of pattern.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out); break;
    case "ArrayPattern": for (const e of pattern.elements) patternNames(e, out); break;
    case "RestElement": patternNames(pattern.argument, out); break;
    case "AssignmentPattern": patternNames(pattern.left, out); break;
  }
  return out;
}

class Scope {
  constructor(parent, isFunction) { this.parent = parent; this.isFunction = isFunction; this.names = new Map(); }
  lookup(name) { for (let s = this; s; s = s.parent) if (s.names.has(name)) return s.names.get(name); return null; }
  get functionScope() { let s = this; while (!s.isFunction) s = s.parent; return s; }
}

/**
 * Reads a factory (its source text, a function or arrow expression).
 * @returns {{ canonical: string, requires: { id: string, method: string, start: number, end: number }[], runtimeMethods: Set<string> }}
 */
function readModule(source) {
  if (!acorn) throw new Error("next-zones: module-code.cjs has no parser (useParser)");
  const ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: "latest", sourceType: "script", allowHashBang: false });
  const requires = [], runtimeMethods = new Set();
  let counter = 0;
  const bind = (scope, id) => { if (!scope.names.has(id.name)) scope.names.set(id.name, `$${counter++}`); };
  /* A binding the parser cannot pin down (with, direct eval): names are kept as written. */
  let dynamic = false;

  /* Hoisting: the var-scoped names of a function body (vars anywhere in it, outside nested functions), and its
     sloppy-mode block functions (Annex B), declared before the body is read. */
  function hoistVars(node, scope, strict) {
    const visit = (n, inBlock) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations) for (const id of patternNames(d.id)) bind(scope, id);
      if (n.type === "FunctionDeclaration" && inBlock && !strict) bind(scope, n.id);
      if (FUNCTION.has(n.type) || n.type === "ClassDeclaration" || n.type === "ClassExpression") return;
      for (const key of Object.keys(n)) {
        if (SKIP_KEYS.has(key)) continue;
        const v = n[key];
        const child = (c) => visit(c, inBlock || n.type === "BlockStatement" || n.type === "SwitchCase");
        if (Array.isArray(v)) v.forEach(child); else if (v && typeof v.type === "string") child(v);
      }
    };
    visit(node, false);
  }
  /* The let, const, class and function declarations directly in a block (or a function body, a switch). */
  function hoistLexical(statements, scope) {
    for (const s of statements) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) for (const id of patternNames(d.id)) bind(scope, id);
      else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) bind(scope, s.id);
    }
  }
  const isStrict = (body) => Array.isArray(body) && body.some((s) => s.type === "ExpressionStatement" && s.directive === "use strict");

  /* The factory's context parameter: its first parameter's binding. */
  let context = null;
  const out = [];
  const emit = (t) => out.push(t);
  const labels = [];
  const privates = [];                                  // the private names of the classes being read, innermost last

  function walkFunction(fn, parent, strict) {
    /* A named function expression sees its own name in a scope of its own. */
    let outer = parent;
    if (fn.type === "FunctionExpression" && fn.id) { outer = new Scope(parent, false); bind(outer, fn.id); }
    const scope = new Scope(outer, true);
    const bodyStrict = strict || (fn.body.type === "BlockStatement" && isStrict(fn.body.body));
    for (const p of fn.params) for (const id of patternNames(p)) bind(scope, id);
    /* Parameters with defaults or patterns are read in a scope of their own: they never see the body's vars. */
    const simple = fn.params.every((p) => p.type === "Identifier");
    const body = simple ? scope : new Scope(scope, true);
    if (fn.body.type === "BlockStatement") { hoistVars(fn.body, body, bodyStrict); hoistLexical(fn.body.body, body); }
    if (context === null && fn.params[0]?.type === "Identifier") context = scope.names.get(fn.params[0].name);
    emit(`${fn.type}(${fn.async ? "a" : ""}${fn.generator ? "g" : ""}`);
    if (fn.type === "FunctionExpression" && fn.id) walk(fn.id, outer, bodyStrict);
    for (const p of fn.params) walk(p, scope, bodyStrict);
    emit("|");
    if (fn.body.type === "BlockStatement") walkStatements(fn.body.body, body, bodyStrict); else walk(fn.body, body, bodyStrict);
    emit(")");
  }
  function walkStatements(statements, scope, strict) { emit("{"); for (const s of statements) walk(s, scope, strict); emit("}"); }

  function identifier(node, scope) {
    if (dynamic) return emit(`@${node.name}`);
    const ref = scope.lookup(node.name);
    emit(ref ?? `@${node.name}`);
  }

  function walk(node, scope, strict) {
    if (node === null || node === undefined) { emit("_"); return; }
    if (Array.isArray(node)) { emit("["); for (const n of node) walk(n, scope, strict); emit("]"); return; }
    switch (node.type) {
      case "Identifier": return identifier(node, scope);
      case "PrivateIdentifier": {
        /* A private name is bound by the class that declares it (the innermost one). */
        for (let i = privates.length - 1; i >= 0; i--) if (privates[i].has(node.name)) return emit(dynamic ? `#@${node.name}` : privates[i].get(node.name));
        return emit(`#@${node.name}`);
      }
      case "Literal":
        if (node.regex) return emit(`R${JSON.stringify([node.regex.pattern, node.regex.flags])}`);
        if (node.bigint !== undefined) return emit(`B${node.bigint}`);
        return emit(`L${typeof node.value}:${JSON.stringify(node.value)}`);
      case "TemplateElement": return emit(`T${JSON.stringify(node.value.cooked ?? node.value.raw)}`);
      case "FunctionDeclaration": emit("FD"); walk(node.id, scope, strict); return walkFunction(node, scope, strict);
      case "FunctionExpression": case "ArrowFunctionExpression": return walkFunction(node, scope, strict);
      case "BlockStatement": {
        const block = new Scope(scope, false);
        hoistLexical(node.body, block);
        return walkStatements(node.body, block, strict);
      }
      case "StaticBlock": {
        const block = new Scope(scope, true);
        hoistVars({ type: "BlockStatement", body: node.body }, block, true);
        hoistLexical(node.body, block);
        emit("static"); return walkStatements(node.body, block, true);
      }
      case "SwitchStatement": {
        emit("switch"); walk(node.discriminant, scope, strict);
        const block = new Scope(scope, false);
        hoistLexical(node.cases.flatMap((c) => c.consequent), block);
        for (const c of node.cases) { emit("case"); walk(c.test, block, strict); for (const s of c.consequent) walk(s, block, strict); }
        return emit("/switch");
      }
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        const loop = new Scope(scope, false);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head?.type === "VariableDeclaration" && head.kind !== "var") for (const d of head.declarations) for (const id of patternNames(d.id)) bind(loop, id);
        emit(node.type + (node.await ? "await" : ""));
        for (const key of node.type === "ForStatement" ? ["init", "test", "update", "body"] : ["left", "right", "body"]) walk(node[key], loop, strict);
        return emit("/for");
      }
      case "CatchClause": {
        const block = new Scope(scope, false);
        for (const id of patternNames(node.param)) bind(block, id);
        emit("catch"); walk(node.param, block, strict);
        return walk(node.body, block, strict);
      }
      case "ClassDeclaration": case "ClassExpression": {
        /* The class's own name is bound inside it too (a const in the class scope). */
        const inner = new Scope(scope, false);
        if (node.id) bind(inner, node.id);
        emit(node.type);
        if (node.id) walk(node.id, node.type === "ClassDeclaration" ? scope : inner, strict);
        walk(node.superClass, scope, true);
        /* Its private names, bound in its body. */
        const own = new Map();
        for (const el of node.body.body) if (el.key?.type === "PrivateIdentifier" && !own.has(el.key.name)) own.set(el.key.name, `#${counter++}`);
        privates.push(own);
        walk(node.body, inner, true);
        privates.pop();
        return;
      }
      case "MemberExpression": {
        /* A require: the context parameter, a one-letter method, a numeric id. */
        /* A use of the module context: `e.g`, `e.i(…)`; what the shell's runtime must give (zone-client.cjs). */
        if (!node.computed && node.object.type === "Identifier" && context !== null && scope.lookup(node.object.name) === context) runtimeMethods.add(node.property.name);
        emit(`M${node.optional ? "?" : ""}${node.computed ? "[" : "."}`);
        walk(node.object, scope, strict);
        if (node.computed || node.property.type === "PrivateIdentifier") walk(node.property, scope, strict); else emit(`P${node.property.name}`);
        return;
      }
      case "CallExpression": {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "eval" && !scope.lookup("eval")) dynamic = true;
        if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && context !== null && scope.lookup(callee.object.name) === context) {
          const method = callee.property.name;
          runtimeMethods.add(method);
          const arg = node.arguments[0];
          if (method.length === 1 && arg?.type === "Literal" && typeof arg.value === "number" && Number.isInteger(arg.value)) {
            requires.push({ id: String(arg.value), method, start: arg.start, end: arg.end });
            emit(`require.${method}(`); for (const a of node.arguments.slice(1)) walk(a, scope, strict); return emit(")");
          }
          /* Re-exports (Turbopack's esmReexport, Next 16.4 on): `e.S([id, names…, 0, id, names…])`, a flat list of groups,
             each headed by the module id its exports come from (or a namespace value), ended by a 0. Each id head is a
             require, in place. */
          if (method === "S" && arg?.type === "ArrayExpression") {
            emit("require.S([");
            let head = true;
            for (const el of arg.elements) {
              if (head && el?.type === "Literal" && Number.isInteger(el.value) && el.value !== 0) {
                requires.push({ id: String(el.value), method, start: el.start, end: el.end });
                emit("R");
              } else walk(el, scope, strict);
              head = el?.type === "Literal" && el.value === 0;
              emit(",");
            }
            emit("]"); for (const a of node.arguments.slice(1)) walk(a, scope, strict); return emit(")");
          }
        }
        break;
      }
      case "Property": case "PropertyDefinition": case "MethodDefinition": {
        /* A key is a name, not a reference (unless computed); a shorthand { a } is { a: a }. */
        emit(`${node.type}:${node.kind ?? ""}${node.static ? "s" : ""}${node.method ? "m" : ""}${node.computed ? "[" : ""}`);
        if (node.computed) walk(node.key, scope, strict);
        else if (node.key.type === "PrivateIdentifier") walk(node.key, scope, strict);
        else emit(node.key.type === "Identifier" ? `K${node.key.name}` : `K${JSON.stringify(node.key.value)}`);
        return walk(node.value, scope, strict);
      }
      case "LabeledStatement": {
        labels.push(node.label.name);
        emit(`label${labels.length}`); walk(node.body, scope, strict);
        labels.pop(); return;
      }
      case "BreakStatement": case "ContinueStatement":
        return emit(`${node.type}${node.label ? labels.lastIndexOf(node.label.name) + 1 : ""}`);
      case "WithStatement": dynamic = true; break;
      case "MetaProperty": return emit(`${node.meta.name}.${node.property.name}`);
    }
    /* Every other node: its type, its own scalar fields (operators, kinds, flags), then its children in order. */
    emit(node.type);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (v !== null && typeof v === "object") { emit(key); walk(v, scope, strict); }
      else if (v !== undefined) emit(`${key}=${v}`);
    }
    emit("/");
  }

  const top = new Scope(null, true);
  walk(ast, top, false);
  /* Read again keeping every name: the dynamic case is only known once read. */
  if (dynamic) { out.length = 0; counter = 0; context = null; requires.length = 0; runtimeMethods.clear(); privates.length = 0; walk(ast, new Scope(null, true), false); }
  /* Joined by newlines, which no token holds (strings are JSON): the form reads back one way only. */
  return { canonical: out.join("\n"), requires, runtimeMethods };
}

/** The source with each required id replaced through `idMap` (id → new id), by the positions readModule found. */
function remapRequires(source, requires, idMap) {
  let out = "", at = 0;
  for (const r of [...requires].sort((a, b) => a.start - b.start)) {
    if (idMap[r.id] === undefined) continue;
    out += source.slice(at, r.start) + String(idMap[r.id]);
    at = r.end;
  }
  return out + source.slice(at);
}

/* Calls that make no state of their own: what they return is a plain value, the same in every copy of a module. */
const PURE = /^(Object\.(freeze|defineProperty|defineProperties|assign|create|keys|values|entries|fromEntries|getOwnPropertyNames|getPrototypeOf|setPrototypeOf)|Array\.(from|isArray|of)|Symbol\.for|JSON\.(parse|stringify)|String|Number|Boolean|parseInt|parseFloat)$/;

/**
 * Whether a factory may hold state of its own, which two copies of the module would not share: at its top level (not
 * inside a function) a call or `new` whose value it keeps (createContext(), new Map(), Symbol()), a statement with an
 * effect (window.x = …), or a top-level binding assigned again anywhere. Calls on the module context (e.i, e.s…) and
 * PURE ones do not count. Conservative: a module it names may still be stateless (an icon made by a call), but one it
 * does not name keeps nothing between calls. Returns the first reason, a short excerpt, or null.
 */
function holdsState(source) {
  if (!acorn) throw new Error("next-zones: module-code.cjs has no parser (useParser)");
  let ast;
  try { ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: "latest", sourceType: "script" }); } catch { return "unreadable"; }
  if (!/Function/.test(ast.type)) return null;
  const context = ast.params[0]?.type === "Identifier" ? ast.params[0].name : null;
  const excerpt = (n) => source.slice(n.start, Math.min(n.end, n.start + 80));
  /* A callee's name; `(0, Object.freeze)` (how bundlers call an import without its receiver) is Object.freeze. */
  const calleeName = (c) => {
    if (c.type === "SequenceExpression") c = c.expressions.at(-1);
    return c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" ? `${c.object.name}.${c.property.name}` : null;
  };
  const onContext = (n) => n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.object.type === "Identifier" && n.callee.object.name === context;
  /* A call or new outside any function, other than on the module context or PURE. */
  const keptCall = (node) => {
    let found = null;
    const walk = (x) => {
      if (!x || typeof x !== "object" || found || /Function/.test(x.type)) return;
      if ((x.type === "CallExpression" || x.type === "NewExpression") && !onContext(x) && !PURE.test(calleeName(x.callee) ?? "")) { found = x; return; }
      for (const k in x) if (k !== "start" && k !== "end") { const v = x[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
    };
    walk(node);
    return found;
  };
  const body = ast.body.type === "BlockStatement" ? ast.body.body : [{ type: "ExpressionStatement", expression: ast.body }];
  const top = new Set();
  for (const st of body) {
    if (st.type === "VariableDeclaration") {
      for (const d of st.declarations) {
        if (d.id.type === "Identifier") top.add(d.id.name);
        const call = d.init && !onContext(d.init) && keptCall(d.init);
        if (call) return excerpt(call);
      }
    } else if (st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") {
      if (st.id) top.add(st.id.name);
    } else if (st.type === "ExpressionStatement") {
      for (const part of st.expression.type === "SequenceExpression" ? st.expression.expressions : [st.expression]) {
        if (onContext(part) || (part.type === "Literal" && typeof part.value === "string")) continue;    // e.s([…]), "use strict"
        if (part.type === "CallExpression" && PURE.test(calleeName(part.callee) ?? "")) continue;       // Object.defineProperty(f, …)
        return excerpt(part);
      }
    } else if (st.type !== "EmptyStatement") return excerpt(st);
  }
  /* A function's own names (its parameters and declarations, not its inner functions'): they hide the top-level ones. */
  const ownNames = (fn) => {
    const names = new Set();
    const bind = (p) => { if (!p) return; if (p.type === "Identifier") names.add(p.name); else if (p.type === "AssignmentPattern") bind(p.left); else if (p.type === "RestElement") bind(p.argument); else if (p.type === "ArrayPattern") p.elements.forEach(bind); else if (p.type === "ObjectPattern") p.properties.forEach((q) => bind(q.value ?? q.argument)); };
    fn.params.forEach(bind);
    if (fn.id && fn.type === "FunctionExpression") names.add(fn.id.name);
    const scan = (x) => {
      if (!x || typeof x !== "object") return;
      if (x.type === "VariableDeclarator") bind(x.id);
      if ((x.type === "FunctionDeclaration" || x.type === "ClassDeclaration") && x.id) names.add(x.id.name);
      if (x.type === "CatchClause") bind(x.param);
      if (/Function/.test(x.type) && x !== fn) return;
      for (const k in x) if (k !== "start" && k !== "end") { const v = x[k]; if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === "object") scan(v); }
    };
    scan(fn.body);
    return names;
  };
  let reassigned = null;
  const walk = (x, hidden) => {
    if (!x || typeof x !== "object" || reassigned) return;
    if (/Function/.test(x.type) && x !== ast) hidden = new Set([...hidden, ...ownNames(x)]);
    const target = x.type === "AssignmentExpression" ? x.left : x.type === "UpdateExpression" ? x.argument : null;
    if (target?.type === "Identifier" && top.has(target.name) && !hidden.has(target.name)) { reassigned = x; return; }
    for (const k in x) if (k !== "start" && k !== "end") { const v = x[k]; if (Array.isArray(v)) v.forEach((e) => walk(e, hidden)); else if (v && typeof v === "object") walk(v, hidden); }
  };
  walk(ast.body, new Set());
  return reassigned ? excerpt(reassigned) : null;
}

module.exports = { useParser, readModule, remapRequires, holdsState };
