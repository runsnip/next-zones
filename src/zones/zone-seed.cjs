/*
 * Runs in a worker thread: seeds a zone image's writable cache from its build (see seedCache in zones.cjs), so the
 * reads, the rewrites and the writes never hold up Zones' event loop.
 */
const { parentPort, workerData, threadId } = require("node:worker_threads");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { payloadTransform, payloadKind } = require("./payload.cjs");

const { cacheDir, mainChunks, routes, idMap = {}, chunkUrls = {}, serverDir, buildId, shellBuildId } = workerData;
const outputs = /\.(html|rsc|meta|body|segment\.rsc)$/;
/* The shell's build id, the zone's main chunk, remapped ids and chunk URLs (payload.cjs). */
const rewrite = payloadTransform({ buildId, shellBuildId, mainChunks, idMap, chunkUrls });
const transform = (file, bytes) => rewrite(bytes, payloadKind(file));
const copy = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copy(source, target);
    else if (outputs.test(entry.name)) fs.writeFileSync(target, transform(entry.name, fs.readFileSync(source)));
  }
};

/* Unique per worker: two installs of one build may seed at the same time, in the same process and millisecond. */
const temp = `${cacheDir}.${process.pid}.${threadId}.${randomUUID()}.tmp`;
const segments = new Set(routes.map((r) => r.split("/")[1]));
const appDir = path.join(serverDir, "app");
fs.mkdirSync(path.join(temp, "app"), { recursive: true });
for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
  if (!segments.has(entry.name.replace(/\..*$/, ""))) continue;
  const source = path.join(appDir, entry.name), target = path.join(temp, "app", entry.name);
  if (entry.isDirectory()) copy(source, target);
  else if (outputs.test(entry.name)) fs.writeFileSync(target, transform(entry.name, fs.readFileSync(source)));
}
try { fs.renameSync(temp, cacheDir); }
catch (error) { fs.rmSync(temp, { recursive: true, force: true }); if (!fs.existsSync(cacheDir)) throw error; }
parentPort.postMessage("seeded");
