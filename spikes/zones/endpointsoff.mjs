/*
 * Undeclared, Zones serves no URL of its own: with endpoints off (NEXT_ZONES_ENDPOINTS=off over the shell's
 * declaration), its paths reach the shell's Next as any other URL, which has no page there.
 */
const status = async (method, p) => (await fetch(`http://127.0.0.1:3900${p}`, { method })).status;
const results = {
  health: await status("GET", "/_next-zones/health"),
  items: await status("GET", "/_next-zones/images"),
  install: await status("POST", "/_next-zones/images/blog/1/install"),
};
const wrong = {};
for (const [k, s] of Object.entries(results)) if (s !== 404) wrong[k] = s;
console.log(JSON.stringify({ results, wrong }, null, 2));
