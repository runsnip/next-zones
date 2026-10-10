/*
 * The incremental cache handler Zones installs through Next's public cacheHandler option.
 * - Zones' own: Next's FileSystemCache, taken from the shell's Next by Zones (hooks.cjs), whose getFilePath sends a
 *   zone's pages to the cache of the zone image that is active.
 * - With the shell's own cacheHandler (a remote cache, say): both, each for its keys. A zone's pages and route handlers
 *   (keys under a zone's mount) go to Zones' cache, which is per version; every other key (the shell's pages, fetch
 *   and unstable_cache data) goes to the shell's handler. A revalidation and a request reset reach both.
 */
const ownKey = (key) => globalThis.__NEXT_ZONES_OWN_KEY__?.(key) ?? key;
const isZoneKey = (key, kind) => (kind === undefined || kind === "APP_PAGE" || kind === "APP_ROUTE") && globalThis.__NEXT_ZONES_IS_ZONE_KEY__?.(key) === true;

class ZonesCacheHandler {
  constructor(options) {
    const Zones = globalThis.__NEXT_ZONES_CACHE_HANDLER__, Own = globalThis.__NEXT_ZONES_SHELL_CACHE_HANDLER__;
    this.zones = new Zones(options);
    this.own = Own ? new Own(options) : this.zones;
  }
  pick(key, kind) { return this.own !== this.zones && isZoneKey(key, kind) ? this.zones : this.own; }
  /* A zone's own not-found page is cached under the zone's mount, not under the shell's /_not-found (hooks.cjs). */
  get(key, ctx) { key = ownKey(key); return this.pick(key, ctx?.kind).get(key, ctx); }
  set(key, data, ctx) { key = ownKey(key); return this.pick(key, data?.kind).set(key, data, ctx); }
  async revalidateTag(...args) { await Promise.all([...new Set([this.zones, this.own])].map((h) => h.revalidateTag?.(...args))); }
  resetRequestCache() { for (const h of new Set([this.zones, this.own])) h.resetRequestCache?.(); }
}

module.exports = ZonesCacheHandler;
