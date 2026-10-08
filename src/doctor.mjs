/*
 * next-zones doctor <dir> [more dirs…] [--store <dir>] [--url <zones url>] [--fast]
 *
 * Checks a workspace of zones from source, before anything is built: everything Zones would refuse at install, and
 * what composing them for `next-zones dev` needs. Each finding comes with what to do.
 *   ✗ an error: Zones would refuse the zone, or the composed dev app would not run (exit code 1);
 *   ! a warning: works, with a cost or a surprise;
 *   ✓ a check that holds.
 * Unless --fast, it also runs Next's and React's own checks on each zone: eslint-config-next's rules (Next's plugin,
 * React's hooks and compiler rules) and the type check of `next build`. Neither Next nor React ships a doctor; these
 * are their official checks, run from the workspace's own installs (nothing is downloaded).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { findZones, declarationProblems } from "./workspace.mjs";

const CONFIG_FILES = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.mts"];
const SHARED_PACKAGES = ["next", "react", "react-dom"];
/* What shapes every URL, or every image: the shell's serves all zones (as stage.cjs checks on a build). */
const SAME_AS_SHELL = ["basePath", "i18n", "trailingSlash", "assetPrefix", "skipTrailingSlashRedirect", "cacheComponents"];
const IMAGE_KEYS = ["remotePatterns", "domains", "localPatterns", "unoptimized", "dangerouslyAllowSVG", "dangerouslyAllowLocalIP"];
/* Files a zone's app/ may hold at its top level besides its mount: used when it runs alone, the shell's on Zones. */
const ROOT_ONLY = /^(layout|not-found|global-error|global-not-found|error|loading|template|default)\.(tsx|ts|jsx|js)$|\.(css|scss|sass)$/;
const SOURCE = /\.(tsx|ts|jsx|js|mjs)$/;

/** A zone's full Next config, as its build would see it (a build for Zones: no alias rewrites of its own). */
async function loadConfig(dir) {
  const file = CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const previous = process.env.NEXT_ZONES_BUILD;
  process.env.NEXT_ZONES_BUILD = "zones";
  try {
    let config = (await import(`${pathToFileURL(file).href}?doctor=${Date.now()}`)).default;
    if (typeof config === "function") config = await config("phase-production-build", { defaultConfig: {} });
    return config ?? {};
  } finally {
    if (previous === undefined) delete process.env.NEXT_ZONES_BUILD; else process.env.NEXT_ZONES_BUILD = previous;
  }
}

const rulesOf = async (config, key) => {
  const value = typeof config[key] === "function" ? await config[key]() : (config[key] ?? []);
  return Array.isArray(value) ? value : [...(value.beforeFiles ?? []), ...(value.afterFiles ?? []), ...(value.fallback ?? [])];
};

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file); else yield file;
  }
}

const SOURCES = ["app", "src", "pages", "components", "lib"];
const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts"];

function runNode(file, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("exit", (code) => resolve({ code, out }));
  });
}

/**
 * The type check `next build` runs, for one zone with its own tsconfig: `next typegen`, then `tsc --noEmit`, both
 * resolved from the zone. { ran: false } when the zone has no tsconfig or TypeScript is not installed.
 * Used by doctor.
 */
export async function checkZoneTypes(z) {
  const req = createRequire(path.join(z.dir, "package.json"));
  const resolve = (id) => { try { return req.resolve(id); } catch { return null; } };
  /* tsc from typescript's own bin field: its exports may not expose bin/. */
  const tsPackage = resolve("typescript/package.json");
  const tscBin = tsPackage && JSON.parse(fs.readFileSync(tsPackage, "utf8")).bin?.tsc;
  const tsc = tscBin && path.join(path.dirname(tsPackage), tscBin), next = resolve("next/dist/bin/next");
  if (!fs.existsSync(path.join(z.dir, "tsconfig.json")) || !tsc || !next) return { ran: false };
  await runNode(next, ["typegen"], z.dir);
  const { code, out } = await runNode(tsc, ["--noEmit", "-p", "."], z.dir);
  return { ran: true, code, out, errors: out.split("\n").filter((l) => /error TS\d+/.test(l)) };
}

/* Next's and React's checks for one zone: lint with the zone's own ESLint config, else eslint-config-next
   (core-web-vitals and typescript); then `next typegen` and `tsc --noEmit`. Each resolved from the zone. */
async function zoneChecks(z) {
  const findings = { lint: [], types: [] };
  const req = createRequire(path.join(z.dir, "package.json"));
  const resolve = (id) => { try { return req.resolve(id); } catch { return null; } };
  const sources = SOURCES.filter((d) => fs.existsSync(path.join(z.dir, d)));
  const list = (items) => items.slice(0, 3).join("\n      ") + (items.length > 3 ? `\n      … ${items.length - 3} more` : "");

  const eslintPath = resolve("eslint");
  const ownConfig = ESLINT_CONFIGS.some((f) => fs.existsSync(path.join(z.dir, f)));
  const nextRules = resolve("eslint-config-next/core-web-vitals");
  if (!eslintPath || (!ownConfig && !nextRules)) {
    findings.lint.push({ notRun: true, level: "!", subject: z.name, text: "Next's and React's lint rules were not run", fix: "add eslint@^9 and eslint-config-next (the version of next) to the workspace's devDependencies" });
  } else if (sources.length) {
    try {
      const { ESLint } = req("eslint");
      const override = ownConfig ? {} : {
        overrideConfigFile: true,
        overrideConfig: [...req("eslint-config-next/core-web-vitals"), ...(resolve("eslint-config-next/typescript") && resolve("typescript") ? req("eslint-config-next/typescript") : [])],
      };
      const results = await new ESLint({ cwd: z.dir, ...override }).lintFiles(sources);
      const messages = results.flatMap((r) => r.messages.map((m) => ({ severity: m.severity, text: `${path.relative(z.dir, r.filePath)}:${m.line} ${m.ruleId ?? ""} ${m.message}` })));
      const errors = messages.filter((m) => m.severity === 2).map((m) => m.text), warnings = messages.filter((m) => m.severity === 1).map((m) => m.text);
      const by = ownConfig ? "its ESLint config" : "eslint-config-next";
      if (errors.length) findings.lint.push({ level: "✗", subject: z.name, text: `${errors.length} lint error${errors.length > 1 ? "s" : ""} (${by}):\n      ${list(errors)}`, fix: "fix them; Next's and React's rules flag what breaks at run time" });
      if (warnings.length) findings.lint.push({ level: "!", subject: z.name, text: `${warnings.length} lint warning${warnings.length > 1 ? "s" : ""} (${by}):\n      ${list(warnings)}` });
      if (!messages.length) findings.lint.push({ level: "✓", subject: z.name, text: `lint clean (${by}, ${results.length} files)` });
    } catch (e) {
      findings.lint.push({ level: "!", subject: z.name, text: `lint could not run: ${e.message.split("\n")[0]}`, fix: "eslint-config-next needs eslint 9" });
    }
  }

  const typed = await checkZoneTypes(z);
  if (typed.ran) {
    const { code, out, errors } = typed;
    if (code !== 0) findings.types.push({ level: "✗", subject: z.name, text: `${errors.length || "some"} type error${errors.length === 1 ? "" : "s"} (next build would fail):\n      ${list(errors.length ? errors : [out.trim().split("\n")[0]])}`, fix: "fix them, or run tsc --noEmit -p " + z.name });
    else findings.types.push({ level: "✓", subject: z.name, text: "types check (next typegen, tsc --noEmit)" });
  }
  return findings;
}

/** Runs every check; returns { errors, warnings } and prints the report. */
export async function doctor({ dirs, store, url, fast = false, print = console.log }) {
  const findings = [];
  const error = (subject, text, fix) => findings.push({ level: "✗", subject, text, fix });
  const warn = (subject, text, fix) => findings.push({ level: "!", subject, text, fix });
  const ok = (subject, text) => findings.push({ level: "✓", subject, text });

  /* 1. Declarations. */
  const { zones, failed } = await findZones(dirs);
  for (const f of failed) error(f.name, `its next.config failed to load: ${f.error}`, "fix the config; next-zones reads it as Next does");
  const declared = declarationProblems(zones);
  for (const p of declared) error("workspace", p, "each zone owns one segment; the shell owns \"/\"");
  if (!zones.length) { error("workspace", `no zone in ${dirs.join(", ")}`, "wrap each app's next.config in zoneConfig({ mount })"); return report(); }
  if (!declared.length) ok("workspace", `${zones.length} zones, one shell: ${zones.map((z) => `${z.name} ${z.mount}`).join(", ")}`);
  const shell = zones.find((z) => z.mount === "/");

  /* 2. One Next, one React: every zone must resolve the same copies, as Zones loads them once. */
  for (const pkg of SHARED_PACKAGES) {
    const copies = new Map();
    for (const z of zones) {
      let where = null;
      try { where = path.dirname(fs.realpathSync(createRequire(path.join(z.dir, "package.json")).resolve(`${pkg}/package.json`))); } catch {}
      if (!where) { error(z.name, `cannot resolve ${pkg}`, `install ${pkg} in the workspace`); continue; }
      const version = JSON.parse(fs.readFileSync(path.join(where, "package.json"), "utf8")).version;
      const key = `${version} at ${where}`;
      copies.set(key, [...(copies.get(key) ?? []), z.name]);
    }
    if (copies.size > 1) error("workspace", `${pkg} resolves to ${copies.size} copies: ${[...copies].map(([k, names]) => `${names.join(", ")} → ${k}`).join("; ")}`, `one ${pkg} for every zone: hoist it to the workspace root, never a second copy in a zone`);
    else if (copies.size === 1) ok("workspace", `one ${pkg}: ${[...copies.keys()][0].split(" at ")[0]}`);
  }

  /* 3. Each zone's config against the shell's; its rules under its mount; its files. */
  const configs = new Map();
  for (const z of zones) {
    try { configs.set(z.name, await loadConfig(z.dir)); }
    catch (e) { error(z.name, `its next.config failed to load: ${e.message}`, "fix the config"); }
  }
  const shellConfig = shell && configs.get(shell.name);
  const env = new Map();
  for (const z of zones) {
    const config = configs.get(z.name);
    if (!config) continue;
    let problems = 0;
    const fail = (...args) => { problems++; error(...args); };
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (env.has(key) && env.get(key).value !== value) warn(z.name, `env ${key} differs from ${env.get(key).zone}'s`, "composed by next-zones dev, a key has one value: give it a name of its own per zone");
      else env.set(key, { value, zone: z.name });
    }
    if (z === shell) {
      for (const file of ["instrumentation-client.ts", "instrumentation-client.js"]) {
        if (fs.existsSync(path.join(z.dir, file)) || fs.existsSync(path.join(z.dir, "src", file))) warn(z.name, `${file} runs in documents the shell serves, that is every page`, "intended for the shell; nothing to do");
      }
      continue;
    }
    if (shellConfig) {
      const differs = SAME_AS_SHELL.filter((key) => JSON.stringify(config[key] ?? null) !== JSON.stringify(shellConfig[key] ?? null));
      if (differs.length) fail(z.name, `${differs.join(", ")} differ from the shell's`, "these shape every URL: set them in the shell's next.config only");
      const images = IMAGE_KEYS.filter((key) => JSON.stringify(config.images?.[key] ?? null) !== JSON.stringify(shellConfig.images?.[key] ?? null));
      if (images.length) fail(z.name, `images.${images.join(", images.")} differ from the shell's`, "the shell's image optimizer serves every zone: put them in the shell's next.config");
    }
    const own = new Set([z.mount, ...(z.aliases ?? []).map((a) => `/${a.source.split("/")[1]}`)]);
    for (const key of ["headers", "redirects", "rewrites"]) {
      for (const rule of await rulesOf(config, key)) {
        const first = `/${(rule.source ?? "").split("/")[1] ?? ""}`;
        if (!own.has(first)) fail(z.name, `its ${key} rule ${rule.source} is outside ${[...own].join(", ")}`, "a zone's rules stay under its mount or its aliases; root rules go in the shell");
      }
    }
    for (const file of ["proxy", "middleware"].flatMap((n) => ["ts", "js"].map((e) => `${n}.${e}`))) {
      if (fs.existsSync(path.join(z.dir, file)) || fs.existsSync(path.join(z.dir, "src", file))) fail(z.name, `has its own ${file}`, "one proxy serves every zone under Zones: move it into the shell's");
    }
    for (const file of ["instrumentation-client.ts", "instrumentation-client.js"]) {
      if (fs.existsSync(path.join(z.dir, file)) || fs.existsSync(path.join(z.dir, "src", file))) fail(z.name, `has ${file}`, "it runs only in the zone's own documents, never when reached from the shell: move it into the shell's");
    }
    const appDir = ["app", "src/app"].map((d) => path.join(z.dir, d)).find((d) => fs.existsSync(d));
    if (!appDir) { fail(z.name, "has no app/ folder", "zones use the App Router"); continue; }
    if (!fs.existsSync(path.join(appDir, z.mount.slice(1)))) fail(z.name, `has no app${z.mount}/`, `its routes live under app${z.mount}/`);
    for (const entry of fs.readdirSync(appDir)) {
      if (entry === z.mount.slice(1) || ROOT_ONLY.test(entry)) continue;
      fail(z.name, `app/${entry} is outside its mount ${z.mount}`, `move it under app${z.mount}/, or into the shell if it belongs at the root`);
    }
    for (const file of walk(appDir)) {
      if (SOURCE.test(file) && /export\s+const\s+runtime\s*=\s*["']edge["']/.test(fs.readFileSync(file, "utf8"))) {
        fail(z.name, `${path.relative(z.dir, file)} uses the edge runtime`, "edge routes are not served by Zones yet: use the Node.js runtime");
      }
    }
    const pub = path.join(z.dir, "public");
    if (fs.existsSync(pub)) {
      const stray = fs.readdirSync(pub).filter((e) => e !== z.mount.slice(1) && !e.startsWith("."));
      if (stray.length) fail(z.name, `public/ has files outside public${z.mount}/: ${stray.join(", ")}`, `move them under public${z.mount}/ (they are served at the root, beside other zones')`);
    }
    if (!problems) ok(z.name, `${z.mount}: config, rules and files fit Zones`);
  }

  /* 4. Path aliases, for next-zones dev: one that differs between zones is given per zone, in the form prefix/*. */
  const aliasTargets = new Map();
  for (const z of zones) {
    const file = path.join(z.dir, "tsconfig.json");
    if (!fs.existsSync(file)) continue;
    let paths = {};
    try { paths = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")).compilerOptions?.paths ?? {}; } catch { continue; }
    for (const [alias, targets] of Object.entries(paths)) (aliasTargets.get(alias) ?? aliasTargets.set(alias, []).get(alias)).push({ zone: z.name, targets });
  }
  for (const [alias, uses] of aliasTargets) {
    if (uses.length < 2) continue;
    const resolved = uses.map((u) => JSON.stringify(u.targets.map((t) => path.resolve(zones.find((z) => z.name === u.zone).dir, t))));
    if (new Set(resolved).size === 1) continue;
    for (const u of uses) {
      if (!alias.endsWith("/*") || u.targets.length !== 1 || !u.targets[0].endsWith("/*")) error(u.zone, `the path alias ${alias} differs from another zone's and is not of the form "prefix/*": ["folder/*"]`, "next-zones dev gives such an alias to each zone's files only in that form");
    }
  }

  /* 5. What must stay out of git: build outputs and generated files, asked of git itself (git check-ignore), so a
     .gitignore anywhere in the repository, or a global one, counts. */
  const inGit = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.resolve(dirs[0]), encoding: "utf8" });
  if (inGit.status !== 0) warn("git", "the workspace is not in a git repository", "nothing to check; with git, run doctor again");
  else {
    const must = [];                                      // [path, what, level]
    for (const dir of dirs) {
      for (const name of [".zones-dev", ".zones-store", ".zones-images", ".zones-cache"]) must.push([path.join(dir, name), `${name}/`, "✗"]);
      must.push([path.join(dir, "node_modules"), "node_modules/", "✗"]);
    }
    for (const z of zones) {
      must.push([path.join(z.dir, ".next"), ".next/", "✗"], [path.join(z.dir, "node_modules"), "node_modules/", "✗"]);
      must.push([path.join(z.dir, "next-env.d.ts"), "next-env.d.ts", "!"], [path.join(z.dir, "tsconfig.tsbuildinfo"), "*.tsbuildinfo", "!"]);
    }
    const missing = new Map();                            // pattern → { level, paths }
    for (const [file, pattern, level] of must) {
      /* A folder is asked through a path inside it: "x/" patterns match folders only, and the folder may not exist yet. */
      const asked = pattern.endsWith("/") ? path.join(path.resolve(file), "file") : path.resolve(file);
      const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", asked], { cwd: path.resolve(dirs[0]) }).status === 0;
      if (ignored) continue;
      const entry = missing.get(pattern) ?? { level, paths: [] };
      entry.paths.push(path.relative(process.cwd(), file) || ".");
      missing.set(pattern, entry);
    }
    for (const [pattern, { level, paths }] of missing) {
      const text = `not ignored by git: ${paths.join(", ")}`;
      const fix = `add "${pattern}" to .gitignore (${pattern === "next-env.d.ts" || pattern === "*.tsbuildinfo" ? "generated by Next and TypeScript" : "build output, never committed"})`;
      if (level === "✗") error("git", text, fix); else warn("git", text, fix);
    }
    if (!missing.size) ok("git", "build outputs and generated files are ignored");
  }

  /* 6. Next's and React's own checks, per zone (unless fast): the rules of eslint-config-next (Next's plugin, React's
     hooks and compiler rules, TypeScript), and the type check `next build` runs, after `next typegen`. */
  if (!fast) {
    const checked = await Promise.all(zones.map((z) => zoneChecks(z)));
    const notRun = checked.flatMap((c) => c.lint).filter((f) => f.notRun);
    /* Not installed for every zone: one finding for the workspace, not one per zone. */
    if (notRun.length === zones.length) findings.push({ ...notRun[0], subject: "workspace" });
    for (const f of checked.flatMap((c) => [...c.lint, ...c.types])) if (!(f.notRun && notRun.length === zones.length)) findings.push(f);
  }

  /* 7. The store and Zones, when given. */
  if (store) {
    const stateFile = path.join(store, "state.json");
    if (!fs.existsSync(store)) warn("store", `${store} does not exist yet`, "next-zones build writes it");
    else if (fs.existsSync(stateFile)) {
      let state = null;
      try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) { error("store", `state.json is not JSON: ${e.message}`, "fix or remove it; Zones rewrites it on install"); }
      for (const [name, version] of Object.entries(state?.zones ?? {})) {
        const zoneJson = path.join(store, name, String(version), "zone.json");
        if (!fs.existsSync(zoneJson)) { error("store", `state.json pins ${name} ${version}, which is not in the store`, `next-zones build … ${name} ${version}, or change the pin`); continue; }
        const built = JSON.parse(fs.readFileSync(zoneJson, "utf8")).built ?? {};
        for (const pkg of SHARED_PACKAGES) {
          let current = null;
          try { current = JSON.parse(fs.readFileSync(createRequire(path.join(shell.dir, "package.json")).resolve(`${pkg}/package.json`), "utf8")).version; } catch {}
          if (built[pkg] && current && built[pkg] !== current) error("store", `${name} ${version} was built with ${pkg} ${built[pkg]}, the shell has ${current}`, `rebuild ${name}: Zones refuses it`);
        }
      }
      if (state) ok("store", `state.json: ${Object.entries(state.zones ?? {}).map(([n, v]) => `${n} ${v}`).join(", ") || "no pins"}`);
    }
  }
  if (url) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      ok("zones", `${url} answers (${res.status})`);
    } catch (e) {
      warn("zones", `${url} does not answer: ${e.cause?.code ?? e.message}`, "next-zones serve --shell <dir> starts it");
    }
  }
  return report();

  function report() {
    const order = { "✗": 0, "!": 1, "✓": 2 };
    for (const f of findings.sort((a, b) => order[a.level] - order[b.level])) {
      print(`${f.level} ${f.subject}: ${f.text}${f.fix ? `\n    → ${f.fix}` : ""}`);
    }
    const errors = findings.filter((f) => f.level === "✗").length, warnings = findings.filter((f) => f.level === "!").length;
    print(errors ? `\n${errors} error${errors > 1 ? "s" : ""}, ${warnings} warning${warnings === 1 ? "" : "s"}` : `\nno errors${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`);
    return { errors, warnings, findings };
  }
}
