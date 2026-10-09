/* Writes many/: 4000 client modules and the one that renders them all, so this zone has enough modules for longer
   ids than the shell's (1368 modules were not enough). next.config.mjs runs it before every build; many/ is not in
   git. */
import fs from "node:fs";
const dir = new URL("./many/", import.meta.url);
const N = 4000, name = (i) => `m${String(i).padStart(4, "0")}`;
const index = new URL("index.js", dir);
/* Written once: Next loads its config several times during a build, while Turbopack reads these files. */
if (!fs.existsSync(index) || !fs.readFileSync(index, "utf8").includes(`${N} modules`)) write();
function write() {
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
for (let i = 0; i < N; i++) fs.writeFileSync(new URL(`${name(i)}.js`, dir), `export const ${name(i)} = ${i};\n`);
fs.writeFileSync(new URL("index.js", dir), `"use client";\n${Array.from({ length: N }, (_, i) => `import { ${name(i)} } from "./${name(i)}.js";`).join("\n")}\n\nconst all = [${Array.from({ length: N }, (_, i) => name(i)).join(", ")}];\n\nexport function Many() {\n  return <p id="many">${N} modules, sum {all.reduce((a, b) => a + b, 0)}</p>;\n}\n`);
}
