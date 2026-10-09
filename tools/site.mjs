#!/usr/bin/env node
/*
 * next-zones.runsnip.net: the documentation as a static site, written to site/ from docs/*.md, llms.txt and
 * llms-full.txt, and RunSnip's icons (sniprender/src/app).
 *
 *   node tools/site.mjs          (npm run site)
 *
 * - index.html: what next-zones is, in a page;
 * - docs/<page>.html for each page of docs/ (docs/index.html for docs/README.md), in the order docs/README.md lists
 *   them, each linking its markdown on GitHub (an alternate, as llmstxt.org suggests);
 * - llms.txt and llms-full.txt at the root, as the package ships them;
 * - site.css, favicon.ico, icon.png, apple-touch-icon.png, robots.txt, sitemap.xml.
 * Markdown is rendered with markdown-it (chosen by benchmark against marked and micromark: the fastest, the same
 * output), headings get GitHub's anchors, so the docs' links (`zones.md#endpoints`) work as they do on GitHub.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { llmsFull } from "./llms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "site");
const SITE = "https://next-zones.runsnip.net";
const REPO = "https://github.com/runsnip/next-zones";
const NPM = "https://www.npmjs.com/package/@runsnip/next-zones";
const RAW = "https://raw.githubusercontent.com/runsnip/next-zones/main";
const ICONS = path.resolve(root, "..", "..", "sniprender", "src", "app");
const MarkdownIt = createRequire(import.meta.url)("markdown-it");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/* Each page's description, for search engines and link previews (the page's first prose otherwise). */
const DESCRIPTIONS = {
  README: "next-zones: build each part of a product as its own Next.js app and serve them as one, with live installs. What it is, what it is not, and the pages of its documentation.",
  concepts: "Zones, the shell, mounts, aliases and versions: what a zone is, what zones share, and what may differ between them.",
  "getting-started": "A workspace of zones from one command: declaring each zone, a shared root layout, developing them together, building and running them.",
  configuration: "zoneConfig: every key of a zone's declaration, the build options Zones needs, the project root, and running a zone alone.",
  cli: "Every next-zones command: init, add, check, doctor, dev, build, start, serve, install, pack, pull, prune and watch, in each mode and output.",
  "routing-rules": "A zone's own headers, redirects and rewrites: what applies, in Next's order, and the rules that keep them under its mount.",
  instrumentation: "instrumentation.ts with zones: the shell's for every route, each zone's for its own, and the policy that decides.",
  updates: "<ZoneUpdates />: open tabs follow a newly installed version. And what every zone needs: Next and React versions, one workspace, the shell's URL settings.",
  zones: "Zones, the server that installs zone images while it runs: the store, its endpoints, installs and rollbacks, pulls, pruning, supported Next versions.",
  metrics: "Zones' own metrics and any zone's, as Prometheus text: what is measured, how to read it, and how a zone measures its own.",
  "pages-router": "Zones on the Pages Router: their files, how their pages are served, live installs, and how they work in every mode.",
  support: "Every area of Next.js under Zones, and how it behaves: what works, what is planned, what a zone may not do.",
};

/* The pages, in the order docs/README.md lists them. */
const readme = fs.readFileSync(path.join(root, "docs", "README.md"), "utf8");
const listed = readme.slice(readme.indexOf("## Pages")).split("\n## ")[0];
const pages = [...listed.matchAll(/\[([^\]]+)\]\(([a-z-]+)\.md\)/g)].map(([, title, name]) => ({ title: title.replace(/`/g, ""), name }));

/* A link of the docs, for the site: a page's .md to its .html, the repository's files to GitHub. */
function siteLink(href) {
  if (/^[a-z]+:/.test(href) || href.startsWith("#")) return href;
  const [file, hash] = href.split("#");
  const anchor = hash ? `#${hash}` : "";
  if (/^[a-z-]+\.md$/.test(file)) return `${file === "README.md" ? "index" : file.replace(/\.md$/, "")}.html${anchor}`;
  if (file.startsWith("../")) return `${REPO}/blob/main/${file.slice(3)}${anchor}`;
  return href;
}

function renderer() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const slug = slugger();
  md.core.ruler.push("anchors", (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t.type !== "heading_open") continue;
      const text = state.tokens[i + 1].children.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("");
      t.attrSet("id", slug(text));
    }
  });
  const link = md.renderer.rules.link_open ?? ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = tokens[i].attrGet("href");
    if (href) tokens[i].attrSet("href", siteLink(href));
    if (/^https?:/.test(tokens[i].attrGet("href") ?? "")) { tokens[i].attrSet("rel", "noopener"); }
    return link(tokens, i, options, env, self);
  };
  /* Wide tables scroll inside the page. */
  md.renderer.rules.table_open = () => '<div class="table"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md;
}

const CSS = `
:root {
  --bg: #f7f8fa; --surface: #ffffff; --fg: #15181d; --muted: #5d6573; --line: #e2e5ea; --code: #f0f2f5;
  --accent: #2357d6; --accent-soft: #e5ecfc;
  --display: "Bricolage Grotesque", "IBM Plex Sans", system-ui, sans-serif;
  --body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111317; --surface: #191c21; --fg: #e8eaee; --muted: #9aa2ae; --line: #2a2f37; --code: #1f232a;
  --accent: #7ea2ff; --accent-soft: #1d2a47; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #111317; --surface: #191c21; --fg: #e8eaee; --muted: #9aa2ae; --line: #2a2f37; --code: #1f232a;
  --accent: #7ea2ff; --accent-soft: #1d2a47; color-scheme: dark }
* { box-sizing: border-box; }
html { scroll-padding-top: 72px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 var(--body); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
code, pre { font-family: var(--mono); font-size: 13px; }
:not(pre) > code { background: var(--code); padding: 1px 5px; border-radius: 5px; overflow-wrap: anywhere; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; overflow-x: auto; line-height: 1.5; }
.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.top .in { max-width: 1180px; margin: 0 auto; padding: 0 16px; height: 56px; display: flex; align-items: center; gap: 18px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--fg); font: 700 18px var(--display); white-space: nowrap; flex: none; }
.brand img { width: 26px; height: 26px; border-radius: 6px; }
.brand .ver { font: 600 11.5px var(--mono); color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px; }
.top nav { margin-left: auto; display: flex; gap: 16px; align-items: center; font-size: 14px; flex-wrap: wrap; }
.top nav a { color: var(--muted); }
.top nav a:hover, .top nav a[aria-current] { color: var(--fg); text-decoration: none; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px; }
.docs { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 40px; padding-block: 28px 64px; }
.side { position: sticky; top: 76px; align-self: start; max-height: calc(100vh - 92px); overflow-y: auto; font-size: 14px; }
.side ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.side a { display: block; padding: 5px 10px; border-radius: 7px; color: var(--muted); }
.side a:hover { background: var(--surface); color: var(--fg); text-decoration: none; }
.side a[aria-current] { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.side .label { font: 600 11.5px var(--body); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 10px 8px; }
article { min-width: 0; max-width: 820px; }
article h1 { font: 700 34px/1.15 var(--display); letter-spacing: -.01em; margin: 6px 0 18px; }
article h2 { font: 600 22px/1.3 var(--body); margin: 36px 0 12px; padding-top: 8px; border-top: 1px solid var(--line); }
article h3 { font: 600 17px/1.35 var(--body); margin: 26px 0 8px; }
article h2 a.anchor, article h3 a.anchor { color: var(--muted); margin-left: 6px; opacity: 0; }
article :is(h2, h3):hover a.anchor { opacity: 1; }
article blockquote { margin: 16px 0; padding: 10px 16px; border-left: 3px solid var(--accent); background: var(--surface); border-radius: 0 10px 10px 0; }
article blockquote > :first-child { margin-top: 0; } article blockquote > :last-child { margin-bottom: 0; }
article li + li { margin-top: 4px; }
.table { overflow-x: auto; margin: 16px 0; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; background: var(--surface); }
th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
th { font-weight: 600; background: var(--code); }
.pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 14px; }
.pager a { display: grid; gap: 2px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); min-width: 0; }
.pager a span { color: var(--muted); font-size: 12px; }
.pager a.next { margin-left: auto; text-align: right; }
.edit { font-size: 13px; color: var(--muted); margin-top: 18px; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
footer .in { max-width: 1180px; margin: 0 auto; padding: 22px 16px 40px; display: flex; flex-wrap: wrap; gap: 8px 22px; }
.hero { padding-block: 64px 36px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; max-width: 860px; }
.hero h1 { font: 700 clamp(34px, 6vw, 56px)/1.05 var(--display); letter-spacing: -.02em; margin: 0; }
.hero p { font-size: 18px; color: var(--muted); margin: 0; max-width: 720px; }
.cta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.btn { display: inline-flex; align-items: center; height: 40px; padding: 0 16px; border-radius: 10px; font-weight: 500; border: 1px solid var(--line); background: var(--surface); color: var(--fg); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:hover { text-decoration: none; filter: brightness(1.05); }
.install { display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 6px 0 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--code); font: 13px var(--mono); max-width: 100%; min-width: 0; }
.install button { flex: none; }
.install code { background: none; padding: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.install button { border: 1px solid var(--line); background: var(--surface); color: var(--fg); border-radius: 7px; font: 500 12px var(--body); height: 28px; padding: 0 10px; cursor: pointer; }
section.band { padding-block: 28px; }
section.band h2 { font: 700 26px/1.2 var(--display); margin: 0 0 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
.card h3 { font: 600 15.5px var(--body); margin: 0 0 6px; }
.card p { margin: 0; color: var(--muted); font-size: 14px; }
.num { font: 700 28px/1.1 var(--display); color: var(--fg); margin-bottom: 4px; }
.steps { counter-reset: s; display: grid; gap: 12px; }
.steps > div { counter-increment: s; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 4px 12px; align-items: start; }
.steps > div::before { content: counter(s); width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font: 600 13px/26px var(--body); text-align: center; }
.steps p { margin: 2px 0 6px; }
.steps pre { margin: 0; grid-column: 2; }
@media (max-width: 860px) {
  .docs { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .side { position: static; max-height: none; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .side ol { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .top nav .wide { display: none; }
}
@media (max-width: 520px) {
  .top .in { gap: 10px; }
  .top nav { gap: 12px; flex-wrap: nowrap; }
  .top nav .narrow { display: none; }
  .brand .ver { display: none; }
  .cta { flex-direction: column; align-items: stretch; }
  .cta .btn { justify-content: center; }
  .install { width: 100%; }
}
`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Bricolage+Grotesque:opsz,wght@12..96,700&display=swap">';

function layout({ title, description, canonical, body, base, current, markdown }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${canonical}">
<link rel="icon" href="${base}favicon.ico" sizes="any">
<link rel="icon" href="${base}icon.png" type="image/png">
<link rel="apple-touch-icon" href="${base}apple-touch-icon.png">
${markdown ? `<link rel="alternate" type="text/markdown" href="${markdown}">` : ""}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${canonical}">
<meta property="og:image" content="${SITE}/icon.png">
<meta name="theme-color" content="#2357d6">
${FONTS}
<link rel="stylesheet" href="${base}site.css">
</head>
<body>
<header class="top"><div class="in">
  <a class="brand" href="${base}index.html"><img src="${base}icon.png" alt="" width="26" height="26">next-zones<span class="ver">v${esc(pkg.version)}</span></a>
  <nav aria-label="Site">
    <a href="${base}docs/index.html"${current === "docs" ? ' aria-current="page"' : ""}>Docs</a>
    <a class="narrow" href="${base}docs/getting-started.html">Get started</a>
    <a class="wide" href="${base}llms.txt">llms.txt</a>
    <a href="${REPO}" rel="noopener">GitHub</a>
    <a class="wide" href="${NPM}" rel="noopener">npm</a>
  </nav>
</div></header>
${body}
<footer><div class="in">
  <span>next-zones · Apache-2.0 · by <a href="https://runsnip.com" rel="noopener">RunSnip</a></span>
  <a href="${REPO}" rel="noopener">GitHub</a>
  <a href="${NPM}" rel="noopener">npm</a>
  <a href="${base}llms.txt">llms.txt</a>
  <a href="${base}llms-full.txt">llms-full.txt</a>
</div></footer>
</body>
</html>
`;
}

function docPage(page, index, all) {
  const file = page.name === "README" ? "README.md" : `${page.name}.md`;
  const source = fs.readFileSync(path.join(root, "docs", file), "utf8");
  const html = renderer().render(source).replace(/<(h[23]) id="([^"]+)">([\s\S]*?)<\/\1>/g, '<$1 id="$2">$3<a class="anchor" href="#$2" aria-label="Link to this section">#</a></$1>');
  const heading = /^# (.+)$/m.exec(source)?.[1] ?? page.title;
  /* The description: the first paragraph of prose (not code, a table, a list or a quote), cut at a sentence. */
  const prose = source.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|>|\||-|\*|\d+\.|<)/.test(p)) ?? "";
  const plain = prose.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim();
  const cut = plain.length <= 200 ? plain : (plain.slice(0, 200).match(/^.*[.:;!?](?=\s)/)?.[0] ?? `${plain.slice(0, 197).replace(/\s\S*$/, "")}…`);
  const firstParagraph = DESCRIPTIONS[page.name] ?? cut;
  const htmlName = page.name === "README" ? "index.html" : `${page.name}.html`;
  const prev = all[index - 1], next = all[index + 1];
  const nameOf = (p) => (p.name === "README" ? "index.html" : `${p.name}.html`);
  const side = `<nav class="side" aria-label="Documentation"><p class="label">Documentation</p><ol>${all.map((p) => `<li><a href="${nameOf(p)}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`).join("")}</ol></nav>`;
  const pager = `<nav class="pager" aria-label="Pages">${prev ? `<a href="${nameOf(prev)}"><span>Previous</span>${esc(prev.title)}</a>` : ""}${next ? `<a class="next" href="${nameOf(next)}"><span>Next</span>${esc(next.title)}</a>` : ""}</nav>`;
  const body = `<div class="wrap docs">${side}<article>${html}${pager}<p class="edit"><a href="${REPO}/blob/main/docs/${file}" rel="noopener">Edit this page on GitHub</a> · <a href="${RAW}/docs/${file}" rel="noopener">Markdown</a></p></article></div>`;
  return {
    html: layout({ title: `${page.name === "README" ? "Documentation" : heading.replace(/`/g, "")} · next-zones`, description: firstParagraph.slice(0, 200), canonical: `/docs/${htmlName}`, body, base: "../", current: "docs", markdown: `${RAW}/docs/${file}` }),
    htmlName,
  };
}

function home() {
  const card = (h, p) => `<div class="card"><h3>${h}</h3><p>${p}</p></div>`;
  const body = `<main class="wrap">
<section class="hero">
  <h1>Zones for Next.js</h1>
  <p>Build each part of a product as its own Next.js app, with its own version. Serve them as one: one origin, one Node process, soft navigation between zones, one React. Install a new version of a zone into the running server, and roll it back, with no restart.</p>
  <div class="cta">
    <a class="btn primary" href="docs/getting-started.html">Get started</a>
    <a class="btn" href="docs/index.html">Read the docs</a>
    <span class="install"><code id="cmd">npx @runsnip/next-zones init my-app blog shop</code><button type="button" id="copy">Copy</button></span>
  </div>
</section>

<section class="band">
  <h2>Not Multi-Zones</h2>
  <div class="table"><table>
    <tr><th></th><th>Next.js Multi-Zones</th><th>next-zones</th></tr>
    <tr><td>Moving between zones</td><td>hard navigation</td><td><b>soft</b> <code>&lt;Link&gt;</code> navigation between App Router pages, client state kept</td></tr>
    <tr><td>Servers</td><td>one per zone</td><td><b>one</b> for all zones</td></tr>
    <tr><td>A module shared by zones</td><td>loaded once per zone</td><td>loaded <b>once</b></td></tr>
    <tr><td>Releasing a zone</td><td>redeploy its server</td><td><b>install it live</b>, roll back the same way</td></tr>
  </table></div>
</section>

<section class="band">
  <h2>Measured</h2>
  <div class="grid">
    <div class="card"><div class="num">3.0–3.2 µs</div><p>for the switch to a newly installed version (p50), a 29-route zone in an app of 248 routes; atomic, and no wrong answer under load.</p></div>
    <div class="card"><div class="num">291.6 MB</div><p>RSS for two real apps and their shell on one Zones, against 500.3 MB for three <code>next start</code>, at the same latency.</p></div>
    <div class="card"><div class="num">16.3.6 → 16.4.0</div><p>Next.js versions the whole suite has passed on. Zones checks every internal it relies on before it hooks anything.</p></div>
  </div>
  <p class="edit">How each was measured: <a href="${REPO}/blob/main/spikes/zones/RESULTS.md" rel="noopener">spikes/zones/RESULTS.md</a>.</p>
</section>

<section class="band">
  <h2>What a zone can use</h2>
  <div class="grid">
    ${card("App Router and Pages Router", "Routing, route handlers, metadata, server actions, prerendering and ISR; and Pages Router zones with <code>getStaticProps</code>, <code>getServerSideProps</code> and their own <code>_app</code>.")}
    ${card("Live installs", "Build an image of one zone, install it while the server runs, roll back with the same command. Open tabs follow with <code>&lt;ZoneUpdates /&gt;</code>.")}
    ${card("One app, if you prefer", "<code>mode: \"single\"</code> links every zone into one Next app for <code>next start</code>. Both modes work with <code>output: \"standalone\"</code> and <code>\"export\"</code>.")}
    ${card("Develop them together", "<code>next-zones dev</code> runs every zone in one <code>next dev</code>, with HMR and soft navigation. <code>next-zones doctor</code> says what to fix.")}
    ${card("Images and pulls", "Zone images are pulled from a folder, a URL template or your own source: streamed, checked against their build's integrity, pruned.")}
    ${card("Metrics", "Zones' own and your zones' measurements, as Prometheus text, from <code>metrics: true</code>.")}
  </div>
</section>

<section class="band">
  <h2>Start</h2>
  <div class="steps">
    <div><p>A workspace: a shared package, the shell (the zone at <code>/</code>) and two zones.</p><pre><code>npx @runsnip/next-zones init my-app blog shop</code></pre></div>
    <div><p>Develop every zone at once.</p><pre><code>cd my-app &amp;&amp; npx next-zones dev .</code></pre></div>
    <div><p>Build the shell and each zone's image, and serve them.</p><pre><code>npx next-zones build &amp;&amp; npx next-zones start</code></pre></div>
    <div><p>Release one zone while it serves.</p><pre><code>npx next-zones build blog &amp;&amp; npx next-zones install blog 1.1.0</code></pre></div>
  </div>
  <p class="edit">Next.js 16.3.6, 16.3.7, 16.3.8 or 16.4.0, and Node.js 24. <a href="docs/getting-started.html">Getting started</a> walks through it.</p>
</section>

<section class="band">
  <h2>For assistants</h2>
  <p><a href="llms.txt"><code>llms.txt</code></a> holds what an assistant most often gets wrong; <a href="llms-full.txt"><code>llms-full.txt</code></a> every page in one file; each page is also <a href="${RAW}/docs/README.md" rel="noopener">markdown</a>. The package ships them, and a skill for coding assistants (<code>skills/next-zones</code>).</p>
</section>
</main>
<script>
document.getElementById("copy").addEventListener("click", (e) => {
  const text = document.getElementById("cmd").textContent;
  const done = () => { e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy"; }, 1400); };
  try { navigator.clipboard.writeText(text).then(done, () => {}); } catch {}
});
</script>`;
  return layout({ title: "next-zones · Zones for Next.js", description: "Build each part of a product as its own Next.js app and serve them as one: one process, soft navigation, live installs and rollbacks. App Router and Pages Router.", canonical: "/", body, base: "", current: "home" });
}

export function buildSite() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "docs"), { recursive: true });
  const all = [{ title: "Overview", name: "README" }, ...pages];
  const written = [];
  all.forEach((page, i) => {
    const p = docPage(page, i, all);
    fs.writeFileSync(path.join(out, "docs", p.htmlName), p.html);
    written.push(`/docs/${p.htmlName}`);
  });
  fs.writeFileSync(path.join(out, "index.html"), home());
  fs.writeFileSync(path.join(out, "site.css"), CSS.trim() + "\n");
  fs.copyFileSync(path.join(root, "llms.txt"), path.join(out, "llms.txt"));
  fs.writeFileSync(path.join(out, "llms-full.txt"), llmsFull());
  for (const [from, to] of [["favicon.ico", "favicon.ico"], ["icon.png", "icon.png"], ["apple-icon.png", "apple-touch-icon.png"]]) fs.copyFileSync(path.join(ICONS, from), path.join(out, to));
  fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  const urls = ["/", ...written, "/llms.txt", "/llms-full.txt"];
  fs.writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  return { pages: all.length, files: fs.readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pages: n, files } = buildSite();
  console.log(`site/: ${n} pages, ${files} files`);
}
