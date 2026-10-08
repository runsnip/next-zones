/*
 * The admin endpoints over zone images (the shell declares endpoints: { admin: true }), on a store holding blog 1 only
 * and a source holding blog 2: a zone image never travels over them. An upload (PUT) is not supported; a pull asks Zones
 * to fetch blog 2 from its source. Then list and read the images, install blog 2, delete blog 1 (never loaded), refuse
 * to delete the active blog 2, and prune (dry run, then for real, with nothing left to remove).
 */
const BASE = "http://127.0.0.1:3900/_next-zones";
const call = async (method, p, body) => { const r = await fetch(BASE + p, { method, body }); return { status: r.status, body: await r.json() }; };

const upload = await call("PUT", "/images/blog/2", Buffer.from("not accepted"));
const pulled = await call("POST", "/images/blog/2/pull");
const listed = await call("GET", "/images");
const one = await call("GET", "/images/blog/2");
const installed = await call("POST", "/images/blog/2/install");
const served = (await (await fetch("http://127.0.0.1:3900/blog/api/x")).json()).version;
const deleteActive = await call("DELETE", "/images/blog/2");
const deleted = await call("DELETE", "/images/blog/1");
const after = await call("GET", "/images");
const dry = await call("POST", "/prune?keep=0&dry=1");
const badKeep = await call("POST", "/prune?keep=-1");

const wrong = {};
if (upload.status !== 405) wrong.upload = upload;
if (pulled.status !== 200 || !pulled.body.pulledFrom) wrong.pulled = pulled;
if (JSON.stringify(listed.body.zones?.blog?.map((i) => i.version).sort()) !== '["1","2"]') wrong.listed = listed.body;
if (one.status !== 200 || !one.body.integrity?.digest) wrong.one = one;
if (installed.status !== 200 || served !== "2") wrong.installed = { installed: installed.status, served };
if (deleteActive.status !== 409 || !/is active/.test(deleteActive.body.refused ?? "")) wrong.deleteActive = deleteActive;
if (deleted.status !== 200) wrong.deleted = deleted;
if (JSON.stringify(after.body.zones?.blog?.map((i) => [i.version, i.active])) !== '[["2",true]]') wrong.after = after.body;
if (dry.status !== 200 || dry.body.removed?.length !== 0 || dry.body.kept?.[0]?.why !== "active") wrong.dry = dry;
if (badKeep.status !== 400) wrong.badKeep = badKeep;
console.log(JSON.stringify({ upload: upload.status, pulled: pulled.body.pulledFrom, installed: installed.status, served, deleteActive: deleteActive.body.refused, deleted: deleted.body, after: after.body, dry: dry.body, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
