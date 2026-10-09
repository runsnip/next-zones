/*
 * next-zones doctor on a workspace built to be wrong (its own git repository, with no .gitignore): one finding per
 * fault, and a clean report on the test zones.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { doctor } from "../../src/doctor.mjs";

const dir = ".doctor-zones";
fs.rmSync(dir, { recursive: true, force: true });
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const config = (zone, extra = "{}") => `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig(${JSON.stringify(zone)}, ${extra});\n`;
const page = "export default function Page() { return null; }\n";

write("shell/package.json", `{ "name": "doctor-shell" }`);
write("shell/next.config.mjs", config({ mount: "/" }, `{ env: { LABEL: "shell" } }`));
write("shell/app/layout.tsx", page);
write("shell/app/page.tsx", page);
write("shell/app/(site)/shell-owned/page.tsx", page);
write("bad/package.json", `{ "name": "doctor-bad" }`);
write("bad/next.config.mjs", config({ mount: "/bad", aliases: [{ source: "/shell-owned/:id", destination: "/bad/:id" }] },
  `{ basePath: "/x", env: { LABEL: "bad" }, images: { remotePatterns: [{ hostname: "example.com" }] }, async rewrites() { return [{ source: "/elsewhere/:p", destination: "/bad/:p" }]; } }`));
write("bad/proxy.ts", "export function proxy() {}\n");
write("bad/instrumentation-client.ts", "\n");
write("bad/app/layout.tsx", page);
write("bad/app/bad/page.tsx", page);
write("bad/app/bad/api/route.ts", `export const runtime = "edge";\nexport function GET() { return new Response("x"); }\n`);
write("bad/app/other/page.tsx", page);
write("bad/public/logo.svg", "<svg/>");
write("bad/pages/legacy.tsx", page);
write("bad/pages/_app.tsx", page);
write("bad/pages/bad/old.tsx", page);
write("bad/pages/api/hello.ts", "export default function handler() {}\n");
/* For Next's and React's own checks: a hook called conditionally, and a type error. */
write("bad/app/bad/counter.tsx", `"use client";
import { useState } from "react";
export function Counter({ on }: { on: boolean }) {
  if (on) { const [n] = useState(0); return <p>{n}</p>; }
  return null;
}
`);
write("bad/app/bad/typed.ts", `export const n: number = "not a number";\n`);
write("bad/tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["./src/*", "./lib/*"] } } }`);
write("other/package.json", `{ "name": "doctor-other" }`);
write("other/next.config.mjs", config({ mount: "/bad" }));
write("other/app/bad/page.tsx", page);
write("other/tsconfig.json", `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`);

/* Its own git repository, with no .gitignore: build outputs are not ignored. */
execFileSync("git", ["init", "-q"], { cwd: dir });

const lines = [];
const broken = await doctor({ dirs: [dir], print: (l) => lines.push(l) });
const clean = await doctor({ dirs: ["fixtures", "."], print: () => {} });
fs.rmSync(dir, { recursive: true, force: true });

const expected = {
  mountTwice: /\/bad is claimed by 2 zones/,
  basePath: /bad: basePath differ from the shell's/,
  images: /bad: images\.remotePatterns differ/,
  ruleOutside: /bad: its rewrites rule \/elsewhere\/:p is outside/,
  proxy: /bad: has its own proxy\.ts/,
  clientInstrumentation: /bad: has instrumentation-client\.ts/,
  outsideMount: /bad: app\/other is outside its mount/,
  edge: /bad: app\/bad\/api\/route\.ts uses the edge runtime/,
  publicStray: /bad: public\/ has files outside public\/bad\/: logo\.svg/,
  shellSegment: /bad: \/shell-owned is the shell's too/,
  pagesOutside: /bad: pages\/legacy\.tsx is outside its mount \/bad/,
  pagesApi: /bad: pages\/api is outside its mount \/bad\n\s*→ pages\/api\/ is served at \/api\//,
  env: /! (bad|shell): env LABEL differs/,
  gitNext: /✗ git: not ignored by git: [^\n]*\.next/,
  gitDev: /✗ git: not ignored by git: [^\n]*\.zones-dev/,
  gitStore: /✗ git: not ignored by git: [^\n]*\.zones-store/,
  gitEnv: /! git: not ignored by git: [^\n]*next-env\.d\.ts/,
  hooks: /✗ bad: \d+ lint errors? \(eslint-config-next\)[\s\S]*react-hooks\/rules-of-hooks/,
  types: /✗ bad: \d+ type errors? \(next build would fail\)[\s\S]*TS2322/,
  aliasForm: /bad: the path alias @\/\* differs from another zone's and is not of the form/,
};
const text = lines.join("\n");
const wrong = {};
for (const [name, re] of Object.entries(expected)) if (!re.test(text)) wrong[name] = "not reported";
if (!broken.errors) wrong.exit = "no errors";
/* Outside a git repository (the upgrade guard's copy), doctor says so: the only warning a clean workspace may have. */
const cleanWarnings = clean.findings.filter((f) => f.level === "!" && !/not in a git repository/.test(f.text));
if (clean.errors || cleanWarnings.length) wrong.clean = `${clean.errors} errors, ${cleanWarnings.map((f) => f.text).join("; ")} on the test zones`;
console.log(JSON.stringify({ errors: broken.errors, warnings: broken.warnings, clean: { errors: clean.errors, warnings: clean.warnings }, wrong }, null, 2));
if (Object.keys(wrong).length) console.log(text);
