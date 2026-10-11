/*
 * The next.config of a composed app (compose.mjs): the shell's config, with each zone's added.
 * - transpilePackages, serverExternalPackages: united.
 * - env: united; one key with two values is refused.
 * - headers, redirects, rewrites: concatenated (zone rules stay under their mounts); the zones' aliases go first, as
 *   beforeFiles rewrites, which is how Zones serves them; a zone's own not-found page last, as a fallback rewrite of
 *   its mount.
 * - turbopack.root: the folder holding every zone, so the linked zone files are inside the project.
 * - turbopack.rules: each zone's own path aliases, for its files (compose-alias-loader.cjs).
 * - turbopack.resolveAlias: united; a relative target (./, ../) is the zone's folder's, so it is rebased onto the
 *   composed app's folder; one key with two targets is refused.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const PHASE_DEVELOPMENT_SERVER = "phase-development-server";      // next/constants

async function load(file, phase) {
  let config = (await import(pathToFileURL(file).href)).default;
  if (typeof config === "function") config = await config(phase, { defaultConfig: {} });
  return config ?? {};
}

const call = async (config, key) => (typeof config[key] === "function" ? await config[key]() : (config[key] ?? []));
const asPhases = (rules) => (Array.isArray(rules) ? { beforeFiles: [], afterFiles: rules, fallback: [] } : { beforeFiles: [], afterFiles: [], fallback: [], ...rules });

/* Each zone's own path aliases, for its files only: a loader rule per zone and source extension, matched on the
   zone's folders (project-relative). The shell's rule leaves out the zones' mounts inside the composed app/. */
function aliasRules(scoped, loader) {
  const escape = (p) => p.split("/").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  const rules = {};
  for (const ext of ["ts", "tsx", "js", "jsx", "mjs"]) {
    rules[`*.${ext}`] = scoped.map(({ files, others, aliases }) => ({
      condition: {
        all: [
          { not: "foreign" },
          { path: new RegExp(`^(${files.map((f) => (f ? `${escape(f)}/` : "")).join("|")})`) },
          ...others.map((o) => ({ not: { path: new RegExp(`^${escape(o)}/`) } })),
        ],
      },
      loaders: [{ loader, options: { aliases } }],
    }));
  }
  return scoped.length ? rules : {};
}

/* A resolveAlias target: a string, a list of them, or conditions ({ browser: … }) holding either. Turbopack reads a
   relative one from the project's folder: the zone's when it runs alone, the composed app's here. */
function rebase(target, from, to) {
  if (typeof target === "string") return /^\.\.?\//.test(target) ? `./${path.relative(to, path.resolve(from, target)).split(path.sep).join("/")}`.replace(/^\.\/\.\.\//, "../") : target;
  if (Array.isArray(target)) return target.map((t) => rebase(t, from, to));
  if (target && typeof target === "object") return Object.fromEntries(Object.entries(target).map(([k, t]) => [k, rebase(t, from, to)]));
  return target;
}

/* phase: the one Next gives the composed config (next dev); each zone's config gets it too. */
export async function mergeConfigs({ shell: shellFile, zones, root, scoped, loader, out }, phase = PHASE_DEVELOPMENT_SERVER) {
  const shell = await load(shellFile, phase);
  const loaded = await Promise.all(zones.map(async (z) => ({ ...z, config: await load(z.file, phase) })));
  const all = [{ name: "shell", file: shellFile, config: shell }, ...loaded];
  const union = (key) => [...new Set(all.flatMap((z) => z.config[key] ?? []))];
  const env = {};
  for (const { name, config } of all) {
    for (const [key, value] of Object.entries(config.env ?? {})) {
      if (key in env && env[key] !== value) throw new Error(`next-zones: env ${key} differs between zones (${name}); composed, a key has one value`);
      env[key] = value;
    }
  }
  const resolveAlias = {};
  for (const { name, file, config } of all) {
    for (const [key, target] of Object.entries(config.turbopack?.resolveAlias ?? {})) {
      const value = out ? rebase(target, path.dirname(file), out) : target;
      if (key in resolveAlias && JSON.stringify(resolveAlias[key]) !== JSON.stringify(value)) {
        throw new Error(`next-zones: turbopack.resolveAlias ${key} differs between zones (${name}); composed, an alias has one target`);
      }
      resolveAlias[key] = value;
    }
  }
  return {
    ...shell,
    env,
    transpilePackages: union("transpilePackages"),
    serverExternalPackages: union("serverExternalPackages"),
    turbopack: { ...shell.turbopack, root, resolveAlias, rules: { ...shell.turbopack?.rules, ...aliasRules(scoped, loader) } },
    agentRules: false,
    /* next dev serves HMR to the listed origins only: localhost and its address are the same machine. */
    allowedDevOrigins: [...new Set([...(shell.allowedDevOrigins ?? []), "127.0.0.1", "localhost"])],
    async headers() { return (await Promise.all(all.map(({ config }) => call(config, "headers")))).flat(); },
    async redirects() { return (await Promise.all(all.map(({ config }) => call(config, "redirects")))).flat(); },
    async rewrites() {
      const phases = (await Promise.all(all.map(({ config }) => call(config, "rewrites")))).map(asPhases);
      const aliases = loaded.flatMap((z) => z.aliases.map(({ source, destination }) => ({ source, destination })));
      return {
        beforeFiles: [...aliases, ...phases.flatMap((p) => p.beforeFiles)],
        afterFiles: phases.flatMap((p) => p.afterFiles),
        /* Last of all: a URL under a zone's mount (or alias) that nothing served, to the page rendering its own
           not-found page (compose.mjs). */
        fallback: [...phases.flatMap((p) => p.fallback), ...loaded.filter((z) => z.notFound).flatMap((z) =>
          [z.mount, ...new Set((z.aliases ?? []).map((a) => `/${a.source.split("/")[1]}`))].map((segment) => ({ source: `${segment}/:path*`, destination: z.notFound })))],
      };
    },
  };
}
