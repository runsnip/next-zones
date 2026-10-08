/*
 * Starting with next-zones:
 *
 *   next-zones init <dir> [zone…] [--no-install]      a new workspace: a shared package, the shell and its zones
 *   next-zones add <zone> [--mount /<segment>]          one more zone in the workspace of the current folder
 *
 * A workspace is a package-manager workspace, one install for every zone:
 *   package.json           the workspaces, the scripts (dev, doctor, build, Zones…), one next/react/react-dom
 *   shared/                the root layout every zone renders (zones must render the same one)
 *   shell/                 the zone mounted at "/": the root layout, the home page, links to the zones
 *   <zone>/                a zone: app/<zone>/ holds its routes, and it runs alone with next dev / next start
 * Each tsconfig extends @runsnip/next-zones/tsconfig/zone.json (what every zone compiles with) and keeps its own @/*.
 * The package manager is the one running this command (npm, yarn, pnpm or bun).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* The versions next-zones is checked against. */
const NEXT = "16.3.8", REACT = "19.3.0";
const PACKAGE_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

function packageManager() {
  const agent = process.env.npm_config_user_agent ?? "";
  return ["pnpm", "yarn", "bun"].find((pm) => agent.startsWith(pm)) ?? "npm";
}

/* The dependency on next-zones: the published version, or this copy before the first publish. */
function nextZonesSpec() {
  const own = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
  return own.private ? `file:${PACKAGE_DIR}` : `^${own.version}`;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function write(root, file, text) {
  const target = path.join(root, file);
  if (fs.existsSync(target)) throw new Error(`${target} exists: next-zones never overwrites a file`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

const tsconfig = () => json({
  extends: "@runsnip/next-zones/tsconfig/zone.json",
  compilerOptions: { paths: { "@/*": ["./src/*"] } },
  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
  exclude: ["node_modules"],
});
const memberPackage = (name, pm) => json({
  /* A zone image is built as this version (next-zones build). */
  name, version: "0.1.0", private: true,
  scripts: { dev: "next dev", build: "next build", start: "next start" },
  dependencies: { shared: pm === "pnpm" ? "workspace:*" : "*" },
});
const layout = `import { RootLayout } from "shared/root-layout";

/* The same root layout in every zone: the shell's serves them all on Zones, a zone's own serves it alone. */
export default RootLayout;
`;

/** Writes one zone into the workspace at `root`. */
function writeZone(root, name, mount, pm) {
  if (!SEGMENT.test(name)) throw new Error(`${name}: a zone's name is lowercase letters, digits and "-"`);
  write(root, `${name}/package.json`, memberPackage(name, pm));
  write(root, `${name}/tsconfig.json`, tsconfig());
  write(root, `${name}/next.config.mjs`, `import { zoneConfig } from "@runsnip/next-zones/config";

export default zoneConfig({ mount: "${mount}" }, {
  transpilePackages: ["shared"],
});
`);
  write(root, `${name}/app/layout.tsx`, layout);
  write(root, `${name}/app${mount}/page.tsx`, `import Link from "next/link";

export default function Page() {
  return (
    <main>
      <h1>${name}</h1>
      <p>This zone lives under ${mount}. <Link href="/">Back to the shell</Link></p>
    </main>
  );
}
`);
  write(root, `${name}/src/.gitkeep`, "");
}

function addToWorkspaces(root, name, pm) {
  if (pm === "pnpm") {
    const file = path.join(root, "pnpm-workspace.yaml");
    fs.appendFileSync(file, `  - ${name}\n`);
    return;
  }
  const file = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.workspaces = [...new Set([...(pkg.workspaces ?? []), name])];
  fs.writeFileSync(file, json(pkg));
}

function install(root, pm) {
  console.log(`\n${pm} install…`);
  const done = spawnSync(pm, ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (done.status !== 0) throw new Error(`${pm} install failed (exit ${done.status})`);
}

export async function init({ dir, zones = [], install: doInstall = true }) {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} is not empty: init starts a new workspace (next-zones add adds a zone to one)`);
  const pm = packageManager();
  const names = zones.length ? zones : ["blog"];
  for (const name of names) if (!SEGMENT.test(name) || name === "shell" || name === "shared") throw new Error(`${name}: not a zone name`);
  const spec = nextZonesSpec();
  const members = ["shared", "shell", ...names];
  const run = (script) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);

  write(root, "package.json", json({
    name: path.basename(root), private: true,
    ...(pm === "pnpm" ? {} : { workspaces: members }),
    scripts: {
      dev: "next-zones dev .",
      doctor: "next-zones doctor . --store .zones-store",
      build: "next-zones build",
      start: "next-zones start",
    },
    dependencies: { "@runsnip/next-zones": spec, next: NEXT, react: REACT, "react-dom": REACT },
    /* eslint 9 and eslint-config-next: Next's and React's rules, which next-zones doctor runs on every zone. */
    devDependencies: { typescript: "^5", "@types/node": "^24", "@types/react": "^19", "@types/react-dom": "^19", eslint: "^9", "eslint-config-next": NEXT },
  }));
  if (pm === "pnpm") write(root, "pnpm-workspace.yaml", `packages:\n${members.map((m) => `  - ${m}\n`).join("")}`);
  /* A copy of next-zones from a folder must be copied in, not linked: Turbopack refuses files outside its root. */
  if (spec.startsWith("file:") && pm === "npm") write(root, ".npmrc", "install-links=true\n");
  write(root, ".gitignore", ["node_modules/", ".next/", "next-env.d.ts", "*.tsbuildinfo", ".zones-dev/", ".zones-store/", ".zones-images/", ".zones-cache/", ""].join("\n"));

  write(root, "shared/package.json", json({
    name: "shared", private: true,
    exports: { "./root-layout": "./src/root-layout.tsx" },
    peerDependencies: { react: "*", "@runsnip/next-zones": "*" },
  }));
  write(root, "shared/src/root-layout.tsx", `import type { ReactNode } from "react";
import { ZoneUpdates } from "@runsnip/next-zones/client";

/* Every zone renders this root layout: on Zones, the shell's document hosts every zone. <ZoneUpdates /> refreshes
   an open tab when Zones installs a new version of a zone. */
export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ZoneUpdates />
        {children}
      </body>
    </html>
  );
}
`);

  write(root, "shell/package.json", memberPackage("shell", pm));
  write(root, "shell/tsconfig.json", tsconfig());
  write(root, "shell/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";

/* The shell: the zone mounted at "/". It declares the URLs Zones serves of its own, under /_next-zones: the swap
   events <ZoneUpdates /> listens to, health for a supervisor, and the admin endpoints (behind NEXT_ZONES_ADMIN_TOKEN)
   that install zone images. Remove what you do not use. */
export default zoneConfig({ mount: "/", endpoints: { events: true, health: true, admin: true } }, {
  transpilePackages: ["shared"],
});
`);
  write(root, "shell/app/layout.tsx", layout);
  write(root, "shell/app/page.tsx", `import Link from "next/link";

const zones = ${JSON.stringify(names.map((n) => `/${n}`))};

export default function Home() {
  return (
    <main>
      <h1>${path.basename(root)}</h1>
      <ul>{zones.map((href) => <li key={href}><Link href={href}>{href}</Link></li>)}</ul>
    </main>
  );
}
`);
  write(root, "shell/src/.gitkeep", "");
  for (const name of names) writeZone(root, name, `/${name}`, pm);

  if (doInstall) install(root, pm);
  console.log(`
Done: ${root}
  ${run("dev")}         every zone on one next dev, with HMR: http://localhost:3000
  ${run("doctor")}      checks the workspace for Zones and for dev
  next-zones add <zone>   one more zone`);
}

export async function add({ zone, mount }) {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, "shell"))) throw new Error("run next-zones add in a workspace made by next-zones init (no shell/ here)");
  const pm = packageManager();
  writeZone(root, zone, mount ?? `/${zone}`, pm);
  addToWorkspaces(root, zone, pm);
  console.log(`Added ${zone} at ${mount ?? `/${zone}`}. Run ${pm} install, then link to it from the shell.`);
}
