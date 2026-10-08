#!/usr/bin/env node
/*
 * Who keeps an object alive: reads a V8 heap snapshot, finds the objects whose name or string value contains <text>
 * (for example a collected zone image's build path), and prints the shortest retainer paths from the GC roots.
 *
 *   node --max-old-space-size=8192 tools/heap-retainers.mjs <file.heapsnapshot> <text> [paths=5] [--skip string,concatenated string] [--holders]
 *
 * With --holders, the targets are the objects that point at such a string (a Module by its filename, a Script by its
 * URL), not the strings, which V8 may keep internalized long after their holders are gone.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const holders = argv.includes("--holders");
if (holders) argv.splice(argv.indexOf("--holders"), 1);
const skipAt = argv.indexOf("--skip");
const skipTypes = new Set(skipAt >= 0 ? argv.splice(skipAt, 2)[1].split(",") : ["string", "concatenated string", "sliced string"]);
const [file, text, many = "5"] = argv;
if (!file || !text) { console.error("usage: heap-retainers.mjs <file.heapsnapshot> <text> [paths]"); process.exit(2); }
const snap = JSON.parse(fs.readFileSync(file, "utf8"));
const { node_fields, edge_fields, node_types, edge_types } = snap.snapshot.meta;
const NF = node_fields.length, EF = edge_fields.length;
const nType = node_fields.indexOf("type"), nName = node_fields.indexOf("name"), nEdges = node_fields.indexOf("edge_count"), nSize = node_fields.indexOf("self_size");
const eType = edge_fields.indexOf("type"), eName = edge_fields.indexOf("name_or_index"), eTo = edge_fields.indexOf("to_node");
const { nodes, edges, strings } = snap;
const count = nodes.length / NF;
const typeNames = node_types[0], edgeTypeNames = edge_types[0];

/* Forward edges by node, then reverse edges (retainers). */
const firstEdge = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) { firstEdge[i] = e; e += nodes[i * NF + nEdges] * EF; firstEdge[i + 1] = e; }
const retainers = Array.from({ length: count }, () => []);
for (let i = 0; i < count; i++) {
  for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
    const type = edgeTypeNames[edges[e + eType]];
    if (type === "weak") continue;
    retainers[edges[e + eTo] / NF].push({ from: i, type, name: type === "element" || type === "hidden" ? edges[e + eName] : strings[edges[e + eName]] });
  }
}
const label = (i) => `${typeNames[nodes[i * NF + nType]]}:${String(strings[nodes[i * NF + nName]]).slice(0, 80)}`;

/* The targets, then a breadth-first walk back to the synthetic root (node 0). */
const targets = [];
const byType = {};
const mentions = (i) => String(strings[nodes[i * NF + nName]]).includes(text);
for (let i = 0; i < count; i++) {
  if (!mentions(i)) continue;
  const type = typeNames[nodes[i * NF + nType]];
  byType[type] = (byType[type] ?? 0) + 1;
  if (holders) { for (const r of retainers[i]) if (!/string/.test(typeNames[nodes[r.from * NF + nType]]) && !mentions(r.from)) targets.push(r.from); }
  else if (!skipTypes.has(type)) targets.push(i);
}
if (holders) {
  const kinds = {};
  for (const t of new Set(targets)) kinds[label(t).slice(0, 60)] = (kinds[label(t).slice(0, 60)] ?? 0) + 1;
  console.log("holders by label:", JSON.stringify(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25), null, 1));
}
console.log(`objects mentioning ${text}, by type: ${JSON.stringify(byType)}; following ${targets.length} (not ${[...skipTypes].join(", ")}):`);
const seenPaths = new Set();
for (const target of targets) {
  if (seenPaths.size >= Number(many)) break;
  const prev = new Map([[target, null]]);
  const queue = [target];
  let found = -1;
  while (queue.length && found < 0) {
    const at = queue.shift();
    for (const r of retainers[at]) {
      if (prev.has(r.from)) continue;
      prev.set(r.from, { to: at, edge: r });
      if (r.from === 0) { found = 0; break; }
      if (typeNames[nodes[r.from * NF + nType]] === "synthetic" && /Internalized strings|\(Strong roots\)/.test(strings[nodes[r.from * NF + nName]])) continue;
      queue.push(r.from);
    }
  }
  if (found < 0) continue;
  const chain = [];
  for (let at = 0; at !== target;) { const step = prev.get(at); chain.push(`${label(at)} -[${step.edge.type} ${step.edge.name}]->`); at = step.to; }
  chain.push(label(target));
  const key = chain.slice(0, 8).join("\n");
  if (seenPaths.has(key)) continue;
  seenPaths.add(key);
  console.log(`\n${chain.join("\n  ")}`);
}
