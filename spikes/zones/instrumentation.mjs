/*
 * The shell's and the zones' instrumentation under Zones: who registered, and whose onRequestError ran for an
 * error on a shell route, on each zone's route, under the default policy and under one that skips the shell for a
 * zone and turns another zone's own off.
 */
const BASE = "http://127.0.0.1:3900";
const post = (p, body) => fetch(BASE + p, { method: "POST", body: body && JSON.stringify(body) });
const log = async () => (await (await fetch(`${BASE}/_next-zones/debug`)).json()).instrumentation;
const errorsOf = async (path) => {
  const before = (await log()).length;
  const status = (await fetch(BASE + path)).status;
  const after = await log();
  return { status, ran: after.slice(before).filter((e) => e.event === "error").map((e) => e.who).sort() };
};

await post("/_next-zones/images/blog/1/install");
await post("/_next-zones/images/shop/1/install");
const registered = (await log()).filter((e) => e.event === "register").map((e) => e.who);
const defaults = { "/boom": await errorsOf("/boom"), "/blog/boom": await errorsOf("/blog/boom"), "/shop/boom": await errorsOf("/shop/boom") };

await post("/_next-zones/policy", { instrumentation: { shell: { skip: ["shop"] }, own: { blog: false } } });
const policed = { "/blog/boom": await errorsOf("/blog/boom"), "/shop/boom": await errorsOf("/shop/boom") };
await post("/_next-zones/policy", { instrumentation: { shell: { skip: [] }, own: {} } });

await post("/_next-zones/images/blog/2/install");
const afterSwap = (await log()).filter((e) => e.event === "register").map((e) => e.who);
console.log(JSON.stringify({ registered, defaults, policed: { policy: "shell skips shop; blog's own off", ...policed }, afterSwap }, null, 2));
