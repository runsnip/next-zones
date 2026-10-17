/*
 * zonecss.mjs's check in one Next app: mode "single" served by next-zones start (next start of the linked app); with
 * NEXT_OUTPUT=export (zonecssexport.mjs) the static site next-zones build exports, served by a plain static file
 * server; with NEXT_ZONES_MODE=zones too (zonecsszonesexport.mjs), zones exported separately and linked into one site.
 * A shell and a zone, "wide", each with a root layout of its own and a stylesheet of its own. Checked: the shell →
 * the zone and the zone → the shell by a soft <Link> navigation, prefetched (the segments) and not (the page's flight
 * data), from a direct load of each; on next start, the same between dynamic pages (the client reference manifest).
 * A style is read from the element it applies to. Before 0.1.2, a navigation between them brought only the
 * stylesheet of the root the document was loaded with.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const cli = path.resolve("../../src/cli.mjs");
const MODE = process.env.NEXT_ZONES_MODE ?? "single";
const EXPORT = process.env.NEXT_OUTPUT === "export";
const dir = path.resolve(`.zonecss-${MODE}${EXPORT ? "-export" : ""}`);
const PORT = 3911, BASE = `http://127.0.0.1:${PORT}`;
const SHELL = "rgb(1, 2, 3)", ZONE = "rgb(4, 5, 6)";
const wrong = {}, seen = {};
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const link = (href, id, prefetch = true) => `<Link href="${href}" id="${id}"${prefetch ? "" : " prefetch={false}"}>${id}</Link>`;
const nav = `import Link from "next/link";\nexport function Nav() { return <nav>${[link("/", "to-home"), link("/", "to-home-np", false), link("/wide", "to-wide"), link("/wide", "to-wide-np", false), ...(EXPORT ? [] : [link("/live", "to-live", false), link("/wide/live", "to-wide-live", false)])].join(" ")}</nav>; }\n`;
const layout = (css) => `import "./${css}";\nimport { Nav } from "./nav";\nexport default function Root({ children }: { children: React.ReactNode }) { return <html lang="en"><body><Nav /><main>{children}</main></body></html>; }\n`;
const page = (title, id) => `export default function Page() { return <><h1 id="title">${title}</h1><p id="${id}">styled</p></>; }\n`;
const live = (title, id) => `import { connection } from "next/server";\nexport default async function Page() { await connection(); return <><h1 id="title">${title}</h1><p id="${id}">styled</p></>; }\n`;
const output = EXPORT ? `, { output: "export" }` : "";

fs.rmSync(dir, { recursive: true, force: true });
for (const [zone, css, color] of [["shell", "shell.css", SHELL], ["wide", "wide.css", ZONE]]) {
  write(`${zone}/package.json`, JSON.stringify({ name: `zonecss-${zone}`, version: "1.0.0", private: true }));
  write(`${zone}/tsconfig.json`, fs.readFileSync("shell/tsconfig.json", "utf8"));
  write(`${zone}/app/nav.tsx`, nav);
  write(`${zone}/app/layout.tsx`, layout(css));
  write(`${zone}/app/${css}`, `#${zone}-styled { color: ${color}; }\n`);
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, zone, "node_modules"), "dir");
}
write("shell/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/", mode: ${JSON.stringify(MODE)} }${output});\n`);
write("wide/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/wide" }${output});\n`);
write("shell/app/page.tsx", page("shell home", "shell-styled"));
write("wide/app/wide/page.tsx", page("zone wide", "wide-styled"));
if (!EXPORT) {
  write("shell/app/live/page.tsx", live("shell live", "shell-styled"));
  write("wide/app/wide/live/page.tsx", live("zone wide live", "wide-styled"));
}

/* A plain static file server: a path, then path.html, then path/index.html, as static hosts do. */
function serve(root, port) {
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".txt": "text/plain", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = [p, `${p}.html`, path.join(p, "index.html")].map((c) => path.join(root, c)).find((c) => c.startsWith(root) && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!file) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

let server = null, browser = null;
try {
  try { execFileSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { wrong.build = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-3000); throw new Error("build failed"); }
  if (EXPORT) server = await serve(path.join(dir, ".zones-export"), PORT);
  else {
    server = spawn(process.execPath, [cli, "start", "--port", String(PORT), "--host", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    server.stdout.on("data", (d) => { log += d; });
    server.stderr.on("data", (d) => { log += d; });
    for (let i = 0; i < 120 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch();
  const tab = await browser.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(e.message));
  tab.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  const color = (id) => tab.waitForSelector(`#${id}`, { timeout: 15000 }).then(() => tab.waitForFunction((id) => {
    const c = getComputedStyle(document.getElementById(id)).color;
    return c !== "rgb(0, 0, 0)" ? c : null;
  }, id, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => tab.evaluate((id) => getComputedStyle(document.getElementById(id)).color, id)));
  /* From a direct load of `from` (its element styled `fromId`), a click on `linkId` to a page whose element is `toId`. */
  const step = async (name, from, fromId, fromColor, linkId, toId, toColor) => {
    await tab.goto(BASE + from);
    const direct = await color(fromId);
    await tab.waitForLoadState("networkidle");
    await tab.evaluate(() => { window.__softMarker = "kept"; });
    await tab.click(`#${linkId}`);
    const soft = await color(toId);
    const same = await tab.evaluate(() => window.__softMarker === "kept");
    seen[name] = { direct, soft, same };
    if (direct !== fromColor || soft !== toColor) wrong[name] = seen[name];
    if (!same) wrong[`${name} not soft`] = "a navigation was not soft: the check does not test what it says";
  };
  await step("shell → zone, prefetched", "/", "shell-styled", SHELL, "to-wide", "wide-styled", ZONE);
  await step("zone → shell, prefetched", "/wide", "wide-styled", ZONE, "to-home", "shell-styled", SHELL);
  await step("shell → zone", "/", "shell-styled", SHELL, "to-wide-np", "wide-styled", ZONE);
  await step("zone → shell", "/wide", "wide-styled", ZONE, "to-home-np", "shell-styled", SHELL);
  if (!EXPORT) {
    await step("shell → zone, dynamic", "/live", "shell-styled", SHELL, "to-wide-live", "wide-styled", ZONE);
    await step("zone → shell, dynamic", "/wide/live", "wide-styled", ZONE, "to-live", "shell-styled", SHELL);
  }
  if (errors.length) wrong.errors = errors;
} catch (error) {
  wrong.error ??= String(error.stack ?? error);
} finally {
  await browser?.close();
  if (server instanceof http.Server) server.close();
  else if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ mode: MODE, output: EXPORT ? "export" : null, seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
