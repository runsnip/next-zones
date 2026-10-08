/*
 * A tab that stays open while the zone is swapped from v1 to v2 on the server: what does it see on its next soft
 * navigation, and after router.refresh()? The client router caches a static route's payload for a while.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const install = (version) => fetch(`http://127.0.0.1:3900/_next-zones/images/blog/${version}/install?strategy=${process.env.STRATEGY ?? "v1"}`, { method: "POST" }).then((r) => r.json());

await install(1);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:3900/");
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#to-blog");
await page.waitForSelector("text=zone blog v1");

await install(2);
await page.click("text=home");
await page.waitForSelector("#title >> text=shell home");
await page.click("#to-blog");
await page.waitForURL("**/blog");
await page.waitForSelector("#title >> text=/zone blog v\\d/");
const afterSoft = await page.textContent("#title");

/* What a Zones service would do on a swap: tell open tabs to refresh their router (here, a full reload of the RSC tree). */
await page.click("text=home");
await page.waitForSelector("#title >> text=shell home");
await page.evaluate(() => { const r = window.next?.router; r?.refresh?.(); });
await page.waitForTimeout(500);
await page.click("#to-blog");
await page.waitForURL("**/blog");
await page.waitForSelector("#title >> text=/zone blog v\\d/");
const afterRefresh = await page.textContent("#title");

console.log(JSON.stringify({ afterSoftNavigation: afterSoft, afterRouterRefresh: afterRefresh, stillSameDocument: await page.evaluate(() => window.__marker === "kept") }, null, 2));
await browser.close();
await install(1);
