/*
 * next-zones init: a new workspace (the shell, two zones) in a temporary folder, installed with npm; it must pass
 * doctor, serve every zone on next-zones dev, and accept one more zone with next-zones add.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("../../src/cli.mjs");
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nz-init-")), "site");
const run = (args, cwd = path.dirname(dir)) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const wrong = {};
const result = {};
let dev = null;
/* check-all stops a check that runs too long with SIGTERM: next dev must not outlive it and hold the port. */
process.once("SIGTERM", () => { dev?.kill(); process.exit(1); });
/* A next dev left on the port (by a run killed some other way) would answer for this one. */
if (await fetch("http://localhost:3905/", { signal: AbortSignal.timeout(2000) }).then(() => true, (e) => e.name === "TimeoutError")) {
  console.log(JSON.stringify({ wrong: { port: "something already listens on :3905 (a next dev left by an earlier run?)" } }));
  process.exit(1);
}
try {
  run(["init", dir, "blog", "shop"]);
  run(["add", "docs"], dir);
  execFileSync("npm", ["install", "--silent"], { cwd: dir, stdio: "ignore" });
  try { result.doctor = run(["doctor", "."], dir).trim().split("\n").pop(); } catch (e) { wrong.doctor = e.stdout; }
  dev = spawn(process.execPath, [cli, "dev", ".", "--port", "3905"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  dev.stdout.on("data", (d) => { log += d; });
  for (let i = 0; i < 120 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  for (const p of ["/", "/blog", "/shop", "/docs"]) {
    /* A first compile can be slow; one that never answers is a failure, not a hang. */
    const res = await fetch(`http://localhost:3905${p}`, { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ status: e.name }));
    result[p] = res.status;
    if (res.status !== 200) wrong[p] = res.status;
  }
} finally {
  /* next dev and its workers go with it, whatever happened. */
  if (dev && dev.exitCode === null) {
    const exited = new Promise((r) => dev.once("exit", r));
    dev.kill();
    await exited;
  }
  fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 5 });
}
console.log(JSON.stringify({ ...result, wrong }, null, 2));
