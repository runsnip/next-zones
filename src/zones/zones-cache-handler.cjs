/*
 * The incremental cache handler Zones installs through Next's public cacheHandler option.
 * - Zones' own: Next's FileSystemCache, taken from the shell's Next by Zones (hooks.cjs), whose getFilePath sends a
 *   zone's pages to the cache of the zone image that is active.
 * - With the shell's own cacheHandler (a remote cache, say): both, each for its keys. A zone's pages and route handlers
 *   (keys under a zone's mount) go to Zones' cache, which is per version; every other key (the shell's pages, fetch
 *   and unstable_cache data) goes to the shell's handler. A revalidation and a request reset reach both.
 * - A page's prerendered flight data, as read, with its root layout's stylesheets named by the segment below the root
 *   (payload.cjs withRootCss): the shell's and every zone's, whichever handler holds it. Done once per entry read.
 */
const { withRootCss } = require("./payload.cjs");
const ownKey = (key) => globalThis.__NEXT_ZONES_OWN_KEY__?.(key) ?? key;
const isZoneKey = (key, kind) => (kind === undefined || kind === "APP_PAGE" || kind === "APP_ROUTE") && globalThis.__NEXT_ZONES_IS_ZONE_KEY__?.(key) === true;

const ROOT_CSS = Symbol("next-zones root css");

class ZonesCacheHandler {
  constructor(options) {
    const Zones = globalThis.__NEXT_ZONES_CACHE_HANDLER__, Own = globalThis.__NEXT_ZONES_SHELL_CACHE_HANDLER__;
    this.zones = new Zones(options);
    this.own = Own ? new Own(options) : this.zones;
  }
  pick(key, kind) { return this.own !== this.zones && isZoneKey(key, kind) ? this.zones : this.own; }
  /* A zone's own not-found page is cached under the zone's mount, not under the shell's /_not-found (hooks.cjs). */
  async get(key, ctx) {
    key = ownKey(key);
    const entry = await this.pick(key, ctx?.kind).get(key, ctx);
    const value = entry?.value;
    if (value?.kind === "APP_PAGE" && Buffer.isBuffer(value.rscData) && !value[ROOT_CSS]) {
      Object.assign(value, withRootCss(value.rscData, value.segmentData ?? null));
      if (value.segmentData === null) delete value.segmentData;
      value[ROOT_CSS] = true;
    }
    return entry;
  }
  set(key, data, ctx) { key = ownKey(key); return this.pick(key, data?.kind).set(key, data, ctx); }
  async revalidateTag(...args) { await Promise.all([...new Set([this.zones, this.own])].map((h) => h.revalidateTag?.(...args))); }
  resetRequestCache() { for (const h of new Set([this.zones, this.own])) h.resetRequestCache?.(); }
}

module.exports = ZonesCacheHandler;
