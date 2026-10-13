/*
 * A zone's stylesheet after a soft navigation. The shell and the zone "wide" each have a root layout of their own,
 * with a stylesheet of their own (shell.css; wide.css, beside the shell's). Both roots are the segment "", so Next
 * renders a soft navigation from below the root and leaves the root's stylesheets out: before the fix, the zone
 * reached from the shell had only the shell's stylesheet, and the shell reached back from a zone loaded directly had
 * only the zone's. Checked: the shell → the zone (softly), the zone → the shell (softly, from a direct load of the
 * zone), and a direct load of each; a style is read from the element it applies to.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";

const installed = await fetch(`${BASE}/_next-zones/images/wide/1/install`, { method: "POST" });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const color = (id) => page.waitForSelector(`#${id}`, { timeout: 15000 }).then(() => page.waitForFunction((id) => {
  const c = getComputedStyle(document.getElementById(id)).color;
  return c !== "rgb(0, 0, 0)" ? c : null;
}, id, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => page.evaluate((id) => getComputedStyle(document.getElementById(id)).color, id)));
const marker = () => page.evaluate(() => (window.__softMarker ??= Math.random()));

const seen = {};
await page.goto(`${BASE}/`);
seen.shellDirect = await color("shell-styled");
const m1 = await marker();
await page.click("#to-wide");
seen.zoneSoft = await color("wide-styled");
seen.zoneSoftSameDocument = (await marker()) === m1;
await page.goto(`${BASE}/wide`);
seen.zoneDirect = await color("wide-styled");
const m2 = await marker();
await page.click('nav a[href="/"]');
seen.shellSoft = await color("shell-styled");
seen.shellSoftSameDocument = (await marker()) === m2;
await browser.close();

const SHELL = "rgb(1, 2, 3)", ZONE = "rgb(4, 5, 6)";
const wrong = {};
if (!installed.ok) wrong.install = installed.status;
if (seen.shellDirect !== SHELL) wrong.shellDirect = seen.shellDirect;
if (seen.zoneDirect !== ZONE) wrong.zoneDirect = seen.zoneDirect;
if (seen.zoneSoft !== ZONE) wrong.zoneSoft = seen.zoneSoft;
if (seen.shellSoft !== SHELL) wrong.shellSoft = seen.shellSoft;
if (!seen.zoneSoftSameDocument || !seen.shellSoftSameDocument) wrong.soft = "a navigation was not soft: the check does not test what it says";
if (errors.length) wrong.errors = errors;
console.log(JSON.stringify({ seen, wrong }, null, 2));
if (Object.keys(wrong).length) process.exit(1);
