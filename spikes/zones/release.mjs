/*
 * next-zones build and start, the owner's cases 2 and 3, on a workspace of this spike's shell, blog and shop (copied
 * into .release, inside this workspace so inside Turbopack's root):
 * - `build`: the shell as an app, blog and shop as images, at the versions their package.json give, zones.json pins;
 * - `start`: Zones serves the shell and installs the pinned images;
 * - `build blog --pack` after a version bump: blog's image alone, packed into .zones-images (the layout a source
 *   serves); building it again is refused (images are immutable), a whole build keeps it;
 * - a ping installs it on the running Zones, which pulls it from .zones-images (blog allows live pulls).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const cli = path.resolve("../../src/cli.mjs");
const dir = path.resolve(".release");
const PORT = 3907, BASE = `http://127.0.0.1:${PORT}`;
const wrong = {}, seen = {};
const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};
const setVersion = (zone, version) => {
  const file = path.join(dir, zone, "package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version }, null, 2));
};

fs.rmSync(dir, { recursive: true, force: true });
for (const [zone, from] of [["shell", "shell"], ["blog", "fixtures/blog"], ["shop", "fixtures/shop"]]) {
  fs.cpSync(from, path.join(dir, zone), { recursive: true, filter: (src) => !/[\\/](\.next|node_modules|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/.test(src) });
  if (fs.existsSync(path.join(from, "node_modules"))) fs.symlinkSync(path.resolve(from, "node_modules"), path.join(dir, zone, "node_modules"), "dir");
  /* Not workspaces of this spike's: their package names must not clash with the originals'. */
  const file = path.join(dir, zone, "package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), name: `release-${zone}` }, null, 2));
}
setVersion("blog", "1.0.0");
setVersion("shop", "2.1.0");

let server = null;
try {
  /* Case 2: the whole workspace. */
  const built = run(["build"]);
  seen.build = built.out.split("\n").filter((l) => l.startsWith("✓"));
  if (built.code !== 0) wrong.build = built.out.slice(-1500);
  const pins = JSON.parse(fs.readFileSync(path.join(dir, "zones.json"), "utf8"));
  if (JSON.stringify(pins) !== JSON.stringify({ zones: { blog: "1.0.0", shop: "2.1.0" } })) wrong.pins = pins;
  for (const [zone, v] of [["blog", "1.0.0"], ["shop", "2.1.0"]]) if (!fs.existsSync(path.join(dir, ".zones-store", zone, v, "zone.json"))) wrong[`image ${zone}`] = "missing";
  if (!fs.existsSync(path.join(dir, "shell", ".next", "BUILD_ID"))) wrong.shell = "not built";

  /* start: Zones, the shell, the pinned images. */
  server = spawn(process.execPath, [cli, "start", "--port", String(PORT), "--host", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 240 && !/Zones on/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const get = async (p) => { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30_000) }); return { status: r.status, body: await r.text() }; };
  seen.started = { "/": (await get("/")).status, "/shop": (await get("/shop")).status, blog: JSON.parse((await get("/blog/api/x")).body).version };
  if (seen.started["/"] !== 200 || seen.started["/shop"] !== 200 || seen.started.blog !== "1.0.0") wrong.started = { ...seen.started, log: log.slice(-800) };

  /* Case 3: blog alone, after a version bump, packed. */
  setVersion("blog", "1.1.0");
  const one = run(["build", "blog", "--pack"]);
  seen.buildBlog = one.out.split("\n").filter((l) => l.startsWith("✓"));
  if (one.code !== 0 || !fs.existsSync(path.join(dir, ".zones-images", "blog", "1.1.0.tgz"))) wrong.buildBlog = one.out.slice(-1500);
  if (fs.existsSync(path.join(dir, ".zones-store", "blog", "1.1.0"))) wrong.packedLeftInStore = true;
  const again = run(["build", "blog"]);
  if (again.code === 0 || !/already built/.test(again.out)) wrong.again = again.out.slice(-500);
  const shell = run(["build", "shell"]);
  if (shell.code === 0 || !/is the shell/.test(shell.out)) wrong.buildShellAlone = shell.out.slice(-500);

  /* A ping installs it: Zones pulls it from .zones-images. */
  const installed = await fetch(`${BASE}/_next-zones/images/blog/1.1.0/install`, { method: "POST" }).then((r) => r.json());
  seen.installed = { pulledFrom: installed.pulledFrom, refused: installed.refused };
  const after = JSON.parse((await get("/blog/api/x")).body).version;
  seen.after = after;
  if (!/zones-images/.test(installed.pulledFrom ?? "") || after !== "1.1.0") wrong.installed = { installed, after };
} catch (error) {
  wrong.error = String(error.stack ?? error);
} finally {
  if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
