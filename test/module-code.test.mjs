/* module-code.cjs: client modules read with a parser (Next's acorn, from the spike's install). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { useParser, readModule, remapRequires } = require("../src/zones/module-code.cjs");
const ACORN = new URL("../spikes/zones/node_modules/next/dist/compiled/acorn/acorn.js", import.meta.url);
const skip = fs.existsSync(ACORN) ? false : "needs spikes/zones installed (npm install there): the parser is Next's";
if (!skip) useParser(require(ACORN.pathname));
const same = (a, b) => readModule(a).canonical === readModule(b).canonical;

test("two minifications of one module are the same: only their bindings' names differ", { skip }, () => {
  assert.ok(same(`(e,t,r)=>{"use strict";let n=e.i(1);r.s(["x",0,function(o){return n.useContext(o)}])}`,
    `(a,b,c)=>{"use strict";let d=a.i(2);c.s(["x",0,function(u){return d.useContext(u)}])}`));
  /* A long local name too (a tokenizer kept every name over three letters). */
  assert.ok(same(`function(e){var longName=1;return longName}`, `function(e){var z=1;return z}`));
});

test("a changed string, property, key, number, regex, template or shape differs", { skip }, () => {
  const base = `(e)=>{let n=e.i(1);return{a:n.b,c:"s",d:1,r:/ab+c/,t:\`a\${n}b\`}}`;
  for (const changed of [
    `(e)=>{let n=e.i(1);return{a:n.x,c:"s",d:1,r:/ab+c/,t:\`a\${n}b\`}}`, `(e)=>{let n=e.i(1);return{z:n.b,c:"s",d:1,r:/ab+c/,t:\`a\${n}b\`}}`,
    `(e)=>{let n=e.i(1);return{a:n.b,c:"t",d:1,r:/ab+c/,t:\`a\${n}b\`}}`, `(e)=>{let n=e.i(1);return{a:n.b,c:"s",d:2,r:/ab+c/,t:\`a\${n}b\`}}`,
    `(e)=>{let n=e.i(1);return{a:n.b,c:"s",d:1,r:/ab+d/,t:\`a\${n}b\`}}`, `(e)=>{let n=e.i(1);return{a:n.b,c:"s",d:1,r:/ab+c/,t:\`a\${n}c\`}}`,
    `(e)=>{let n=e.i(1);return[{a:n.b,c:"s",d:1,r:/ab+c/,t:\`a\${n}b\`}]}`,
  ]) assert.ok(!same(base, changed), changed);
});

test("what a tokenizer took for the same code is not: free names, scopes, calls on locals", { skip }, () => {
  /* Two globals with short names. */
  assert.ok(!same(`function(e){return top}`, `function(e){return foo}`));
  /* A default parameter does not see the body's vars: x and y are globals here. */
  assert.ok(!same(`function(a=x){var x}`, `function(a=y){var y}`));
  /* A sloppy-mode function declared in a block is seen after it (Annex B): a() is that function, or a global. */
  assert.ok(!same(`function(e){{function a(){}} return a()}`, `function(e){{function b(){}} return a()}`));
  /* Which binding a name refers to. */
  assert.ok(!same(`function(e){var a=1;return function(a){return a}}`, `function(e){var a=1;return function(b){return a}}`));
  /* A call on a local is not a require: its argument counts. */
  assert.ok(!same(`function(e){var o={f(){}};return o.f(3)}`, `function(e){var o={f(){}};return o.f(4)}`));
  /* with makes names dynamic: they are kept. */
  assert.ok(!same(`function(e){with(x){return y}}`, `function(e){with(x){return z}}`));
  /* A method is not a function-valued property. */
  assert.ok(!same(`function(e){return{a(){}}}`, `function(e){return{a:function(){}}}`));
});

test("requires are calls on the factory's context, found where they are; the rest is left alone", { skip }, () => {
  const source = `function(e){var t=e.r(12),o={f(){}};e.A(7);var e2=e.v("x");return o.f(3)+function(e){return e.r(5)}()}`;
  const { requires, runtimeMethods } = readModule(source);
  assert.deepEqual(requires.map((r) => [r.method, r.id]), [["r", "12"], ["A", "7"]], "o.f(3) is a local's; the inner e shadows the context");
  assert.deepEqual([...runtimeMethods].sort(), ["A", "r", "v"]);
  /* A context property read, not called, is a use too (the runtime must give it); a shadowing local's is not. */
  assert.deepEqual([...readModule(`function(e){var g=e.g.document;return function(e){return e.q}}`).runtimeMethods], ["g"]);
  assert.equal(remapRequires(source, requires, { 12: 100000000000001 }), source.replace("e.r(12)", "e.r(100000000000001)"));
  /* The required ids are blanked: a dependency counts by what it is, hashed in by zone-client.cjs. */
  assert.ok(same(`function(e){return e.i(1)}`, `function(t){return t.i(2)}`));
});

test("a class's private names are bindings: renamed alike, never a public property", { skip }, () => {
  assert.ok(same(`function(e){return class{#i=1;#o;m(){return this.#i+this.#o}}}`, `function(e){return class{#a=1;#b;m(){return this.#a+this.#b}}}`));
  assert.ok(!same(`function(e){return class{#i;#o;m(){return this.#i}}}`, `function(e){return class{#i;#o;m(){return this.#o}}}`));
  assert.ok(!same(`function(e){return class{#i;m(){return this.#i}}}`, `function(e){return class{i;m(){return this.i}}}`));
  assert.ok(!same(`function(e){return class{#i;m(o){return #i in o}}}`, `function(e){return class{#i;m(o){return o}}}`));
});

test("re-exports (e.S, Next 16.4) require the module heading each group, and are remapped in place", { skip }, () => {
  const source = `e=>{e.i(55863),e.S([25098,"Counter,Counter",0,7,"a","b",0,n,"x","y"])}`;
  const m = readModule(source);
  assert.deepEqual(m.requires.map((r) => [r.id, r.method]), [["55863", "i"], ["25098", "S"], ["7", "S"]]);
  assert.equal(remapRequires(source, m.requires, { 25098: 100000000000001 }),
    `e=>{e.i(55863),e.S([100000000000001,"Counter,Counter",0,7,"a","b",0,n,"x","y"])}`);
  /* The ids are not part of a module's identity (its requires stand for their own); the names are. */
  assert.ok(same(source, `e=>{e.i(1),e.S([2,"Counter,Counter",0,3,"a","b",0,n,"x","y"])}`));
  assert.ok(!same(source, `e=>{e.i(55863),e.S([25098,"Counter,Other",0,7,"a","b",0,n,"x","y"])}`));
});
