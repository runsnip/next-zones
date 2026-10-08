/*
 * The composer, for development: the shell and its zones as one Next app.
 *
 *   next-zones dev <zones dir> [--port 3000]      one `next dev` serves them all, with Next's own HMR, soft navigation
 *                                                 and one React (<zones dir>/.zones-dev)
 *
 * Production builds never compose sources: zones are built as images, which Zones installs (mode "zones") or the link
 * makes one Next app of (mode "single", link-app.mjs): one zone format.
 *
 * It writes the app made of links to the zones' own files:
 * - app/: the shell's app/ entries, and each zone's app/<mount>/ under its mount, as real folders of links to files.
 *   A zone's other top-level app files (its root layout, its root not-found) are its own when it runs alone;
 *   composed, the shell's are used, as on Zones.
 * - public/: the shell's and each zone's public files.
 * - next.config.mjs: the shell's config, with every zone's transpilePackages, env, headers, redirects and rewrites
 *   added, and the zones' aliases as rewrites.
 * - postcss.config.mjs: the shell's, with Tailwind scanning the zones dir.
 * - tsconfig.json: the shell's, with the path aliases all zones agree on. Next reads one tsconfig per app (checked: a
 *   zone's own tsconfig is not read for its files), so an alias each zone points to its own folder (`@/*`) is given
 *   to each zone's files by a loader rule instead.
 * - instrumentation.ts: the shell's, linked; or, when a zone has its own, one that runs them as Zones does (the shell's
 *   for every route, each zone's for its routes, under zones.config.json's policy).
 * Nothing is copied: an edit to a zone's file is an edit Next's dev server sees through the link.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findZones } from "./workspace.mjs";

async function findShellAndZones(zonesDir) {
  const { zones, failed } = await findZones([zonesDir]);
  if (failed.length) throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join("\n"));
  const shells = zones.filter((z) => z.mount === "/");
  if (shells.length !== 1) throw new Error(`${zonesDir}: exactly one zone must have mount "/" (found ${shells.length})`);
  return { shell: shells[0], zones: zones.filter((z) => z.mount !== "/") };
}

const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at); };

/* A folder mirrored as real folders holding links to its files: Next's route discovery does not enter linked
   folders, while a linked file resolves to the zone's own file (its real path: module ids, HMR, its node_modules). */
function mirror(source, at) {
  if (!fs.statSync(source).isDirectory()) return link(source, at);
  fs.mkdirSync(at, { recursive: true });
  for (const entry of fs.readdirSync(source)) mirror(path.join(source, entry), path.join(at, entry));
}

/* Keeps a mirror in step with its source while next dev runs: files and folders added, removed or edited. */
function follow(source, at) {
  fs.watch(source, { recursive: true }, (event, file) => {
    if (!file) return;
    const from = path.join(source, file), to = path.join(at, file);
    const exists = fs.existsSync(from);
    let present = false;
    try { fs.lstatSync(to); present = true; } catch {}
    if (exists && !present) mirror(from, to);
    else if (!exists && present) fs.rmSync(to, { recursive: true, force: true });
    /* An edit to a linked file changes nothing in the mirror, which is what next dev watches: the link is made again,
       so the change is seen there too. */
    else if (exists && present && !fs.statSync(from).isDirectory()) { fs.rmSync(to, { force: true }); fs.symlinkSync(from, to); }
  });
}

/* tsconfig is JSON with comments and trailing commas: both are dropped outside strings. */
function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/* The folder holding every zone's real files: Turbopack's root must contain every file it compiles. */
function commonRoot(dirs) {
  const parts = dirs.map((d) => fs.realpathSync(d).split(path.sep));
  let n = 0;
  while (parts.every((p) => p[n] !== undefined && p[n] === parts[0][n])) n++;
  return parts[0].slice(0, n).join(path.sep) || path.sep;
}

/** The folder the composed app is written to, for `next dev`. */
export const composedDir = (zonesDir) => path.join(path.resolve(zonesDir), ".zones-dev");

/** Writes the composed app (<zones dir>/.zones-dev) and returns its path. */
export async function compose(zonesDir) {
  zonesDir = path.resolve(zonesDir);
  const { shell, zones } = await findShellAndZones(zonesDir);
  const out = composedDir(zonesDir);
  /* Next's dev output (.next) survives a recompose, so a restart stays warm. */
  for (const entry of fs.existsSync(out) ? fs.readdirSync(out) : []) if (entry !== ".next") fs.rmSync(path.join(out, entry), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  /* app/ */
  const mounts = new Set(zones.map((z) => z.mount.slice(1)));
  const trees = [];
  for (const entry of fs.readdirSync(path.join(shell.dir, "app"))) {
    if (mounts.has(entry)) throw new Error(`${shell.name}: app/${entry} is the mount of another zone`);
    trees.push([path.join(shell.dir, "app", entry), path.join(out, "app", entry)]);
  }
  for (const z of zones) {
    const tree = path.join(z.dir, "app", z.mount.slice(1));
    if (!fs.existsSync(tree)) throw new Error(`${z.name}: no app${z.mount}/`);
    trees.push([tree, path.join(out, "app", z.mount.slice(1))]);
  }
  for (const [source, at] of trees) mirror(source, at);

  /* public/ */
  for (const z of [shell, ...zones]) {
    const pub = path.join(z.dir, "public");
    if (!fs.existsSync(pub)) continue;
    for (const entry of fs.readdirSync(pub)) {
      const at = path.join(out, "public", entry);
      if (fs.existsSync(at)) throw new Error(`${z.name}: public/${entry} is also another zone's`);
      link(path.join(pub, entry), at);
    }
  }

  /* tsconfig.json: the shell's, with the path aliases every zone gives the same target. An alias whose target
     differs between zones (each zone's `@/*` → its own src/) cannot live in the one tsconfig Next reads: each zone's
     files get it from a loader instead (compose-alias-loader.cjs), so every zone keeps its own `@/*`. */
  const tsconfig = readJson(path.join(shell.dir, "tsconfig.json"));
  const declared = new Map();                             // alias → [{ zone, targets (absolute) }]
  for (const z of [shell, ...zones]) {
    const file = path.join(z.dir, "tsconfig.json");
    if (!fs.existsSync(file)) continue;
    const options = readJson(file).compilerOptions ?? {};
    const base = path.resolve(z.dir, options.baseUrl ?? ".");
    for (const [alias, targets] of Object.entries(options.paths ?? {})) {
      (declared.get(alias) ?? declared.set(alias, []).get(alias)).push({ zone: z, targets: targets.map((t) => path.resolve(base, t)) });
    }
  }
  const paths = {};
  const scoped = new Map();                               // zone name → [{ prefix, target }]
  for (const [alias, uses] of declared) {
    const same = uses.every((u) => JSON.stringify(u.targets) === JSON.stringify(uses[0].targets));
    if (same) { paths[alias] = uses[0].targets.map((t) => path.relative(out, t)); continue; }
    for (const { zone, targets } of uses) {
      if (!alias.endsWith("/*") || targets.length !== 1 || !targets[0].endsWith(`${path.sep}*`)) {
        throw new Error(`${zone.name}: the path alias ${alias} differs from another zone's, and only "prefix/*" → one "folder/*" can be given per zone`);
      }
      (scoped.get(zone.name) ?? scoped.set(zone.name, []).get(zone.name)).push({ prefix: alias.slice(0, -1), target: targets[0].slice(0, -1) });
    }
  }
  /* paths are relative to this tsconfig, which needs no baseUrl (deprecated from TypeScript 6). */
  const { baseUrl: _, ...compilerOptions } = tsconfig.compilerOptions ?? {};
  tsconfig.compilerOptions = { ...compilerOptions, paths: Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, v.map((t) => (t.startsWith(".") ? t : `./${t}`))])) };
  tsconfig.include = ["next-env.d.ts", "app/**/*.ts", "app/**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"];
  fs.writeFileSync(path.join(out, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");

  /* The shell's other project files: proxy; instrumentation, unless a zone has its own (below). */
  const instrumentationOf = (dir) => ["", "src"].flatMap((d) => ["ts", "js", "mjs"].map((e) => path.join(dir, d, `instrumentation.${e}`))).find((f) => fs.existsSync(f));
  const zoneInstrumentation = zones.map((z) => ({ z, file: instrumentationOf(z.dir) })).filter((i) => i.file);
  for (const file of fs.readdirSync(shell.dir)) {
    if (/^(proxy|middleware)\.(m?js|ts|cjs)$/.test(file) || (!zoneInstrumentation.length && /^instrumentation\.(m?js|ts|cjs)$/.test(file))) link(path.join(shell.dir, file), path.join(out, file));
  }
  /* With a zone's own instrumentation: one that runs as Zones does (instrumentation.cjs). The shell's for every route,
     each zone's for its own routes, under the workspace's policy (zones.config.json: shell.skip, own). */
  if (zoneInstrumentation.length) {
    const shellFile = instrumentationOf(shell.dir);
    const spec = (file) => JSON.stringify(path.relative(out, file).split(path.sep).join("/").replace(/^(?!\.)/, "./").replace(/\.(ts|js|mjs)$/, ""));
    let policy = {};
    try { policy = JSON.parse(fs.readFileSync(path.join(zonesDir, "zones.config.json"), "utf8")).instrumentation ?? {}; } catch {}
    fs.writeFileSync(path.join(out, "instrumentation.ts"), `/* Written by next-zones dev: the shell's instrumentation for every route, each zone's own for its routes, as on Zones. */
${shellFile ? `import * as shell from ${spec(shellFile)};` : "const shell: Instrumentation = {};"}
${zoneInstrumentation.map((i, n) => `import * as zone${n} from ${spec(i.file)};`).join("\n")}

type Instrumentation = { register?: () => unknown; onRequestError?: (...args: any[]) => unknown };
const policy: { shell?: { skip?: string[] }; own?: Record<string, boolean> } = ${JSON.stringify(policy)};
const zones: { name: string; mount: string; own: Instrumentation }[] = [
${zoneInstrumentation.map((i, n) => `  { name: ${JSON.stringify(i.z.name)}, mount: ${JSON.stringify(i.z.mount)}, own: zone${n} as Instrumentation },`).join("\n")}
];
const mounts = ${JSON.stringify(zones.map((z) => ({ name: z.name, mount: z.mount })))};
const ownRuns = (name: string) => policy.own?.[name] !== false;

export async function register() {
  await (shell as Instrumentation).register?.();
  for (const z of zones) if (ownRuns(z.name)) await z.own.register?.();
}

export async function onRequestError(error: unknown, request: { path?: string }, context: { routePath?: string }) {
  const at = context?.routePath ?? request?.path ?? "";
  const name = mounts.find((m) => at === m.mount || at.startsWith(\`\${m.mount}/\`))?.name;
  if (!name || !(policy.shell?.skip ?? []).includes(name)) await (shell as Instrumentation).onRequestError?.(error, request, context);
  const own = name && ownRuns(name) ? zones.find((z) => z.name === name)?.own : undefined;
  if (own?.onRequestError) {
    try { await own.onRequestError(error, request, context); }
    catch (e) { console.error(\`Error in zone "\${name}" instrumentation.onRequestError:\`, e); }
  }
}
`);
  }
  /* The shell's PostCSS config, with Tailwind scanning from the zones dir: from the composed app it would see only
     links (not a zone's src/) and its own .next. */
  const postcss = fs.readdirSync(shell.dir).find((f) => /^postcss\.config\.(m?js|cjs)$/.test(f));
  if (postcss) {
    /* Read here and written out as data: Turbopack bundles the PostCSS config, and cannot import the shell's file. */
    const config = (await import(pathToFileURL(path.join(shell.dir, postcss)).href)).default;
    const plugins = { ...config.plugins };
    if ("@tailwindcss/postcss" in plugins) plugins["@tailwindcss/postcss"] = { ...plugins["@tailwindcss/postcss"], base: zonesDir };
    fs.writeFileSync(path.join(out, "postcss.config.mjs"), `/* Written by next-zones dev: the shell's PostCSS config, Tailwind scanning every zone. */
export default ${JSON.stringify({ ...config, plugins }, null, 2)};
`);
  }
  /* Generated: out of git, and out of Tailwind's scan (it honours .gitignore). */
  fs.writeFileSync(path.join(out, ".gitignore"), "*\n");
  fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ name: "next-zones-dev", private: true }, null, 2) + "\n");

  /* next.config.mjs: the configs merged at load time, by next-zones itself. */
  /* Turbopack's root holds every zone and the node_modules Next is installed in, which a workspace may hoist above the
     zones' own folder. */
  const nextPackage = createRequire(path.join(shell.dir, "package.json")).resolve("next/package.json");
  const modulesHome = nextPackage.slice(0, nextPackage.lastIndexOf(`${path.sep}node_modules${path.sep}`));
  const root = commonRoot([zonesDir, shell.dir, ...zones.map((z) => z.dir), modulesHome]);
  const configOf = (dir) => ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.mts"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  fs.writeFileSync(path.join(out, "next.config.mjs"), `/* Written by next-zones dev: the shell and its zones as one app. Do not edit. */
import { mergeConfigs } from ${JSON.stringify(new URL("./compose-config.mjs", import.meta.url).href)};
export default (phase) => mergeConfigs(${JSON.stringify({
    shell: configOf(shell.dir),
    zones: zones.map((z) => ({ name: z.name, file: configOf(z.dir), aliases: z.aliases })),
    root,
    /* Per zone: the folders its files are seen from (its own, and its mount in the composed app/), and its aliases. */
    scoped: [shell, ...zones].filter((z) => scoped.has(z.name)).map((z) => ({
      files: [path.relative(root, z.dir), path.relative(root, path.join(out, "app", z.mount === "/" ? "" : z.mount.slice(1)))],
      others: z.mount === "/" ? zones.map((o) => path.relative(root, path.join(out, "app", o.mount.slice(1)))) : [],
      aliases: scoped.get(z.name),
    })),
    loader: fileURLToPath(new URL("./compose-alias-loader.cjs", import.meta.url)),
  })}, phase);
`);
  return { out, shell, zones, trees };
}

/** Composes, then runs `next dev` on the result. */
export async function composeDev({ zonesDir, port = 3000 }) {
  const { out, shell, zones, trees } = await compose(zonesDir);
  for (const [source, at] of trees) if (fs.statSync(source).isDirectory()) follow(source, at);
  console.log(`next-zones dev: ${shell.name} at /, ${zones.map((z) => `${z.name} at ${z.mount}`).join(", ")}`);
  const next = createRequire(path.join(shell.dir, "package.json")).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [next, "dev", "-p", String(port)], { cwd: out, stdio: "inherit", env: { ...process.env, NEXT_ZONES_BUILD: "dev" } });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}


