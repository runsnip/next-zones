"use strict";
/*
 * Next's LRUCache, as Zones has it (hooks.cjs): a switch drops the cached entries under the zone's first path segments
 * ("/blog/1", "/blog/page:…", "/route-cache/APP_PAGE/<hash>/$/blog/1" → "blog") lazily. Each key remembers its segment's generation when it is set; a switch
 * bumps the generation of the zone's segments (O(segments), not O(cached keys)); an older key reads as absent and is
 * removed.
 *
 * What it adds to memory (D3) is one generation number per entry the LRU holds: `born` is kept in step with the cache
 * (set when the LRU takes an entry, deleted when it evicts or removes one), so it never outgrows the LRU's own bound.
 */
/**
 * The page path a cache key is for. Next keys a response by its path ("/blog/1", "/blog/page:…"), and from 16.3.8 under
 * the route that owns it: "/route-cache/<kind>/<sha256 of the source route>/$/blog/1". Zones routes and drops entries
 * by that path's first segment.
 */
function keyPath(key) {
  const k = String(key);
  if (k.startsWith("/route-cache/")) {
    const at = k.indexOf("/$/");
    if (at !== -1) return k.slice(at + 2);
  }
  return k;
}
/** A cache key's zone segment: the first segment of the page path it is for ("blog"), or "". */
function segmentOf(key) {
  const m = /^\/([^/:.]*)/.exec(keyPath(key));
  return m ? m[1] : "";
}

function keptLRU(LRUCache, generations, onCreate) {
  return class KeptLRU extends LRUCache {
    constructor(maxSize, calculateSize, onEvict) {
      super(maxSize, calculateSize, (key, value) => { this.born.delete(key); onEvict?.(key, value); });
      this.born = new Map();
      onCreate?.(this);
    }
    static segmentOf(key) { return segmentOf(key); }
    stale(key) {
      const born = this.born.get(key);
      return born !== undefined && born !== (generations.get(KeptLRU.segmentOf(key)) ?? 0);
    }
    /* Recorded only if the LRU took it: Next's refuses an entry larger than its bound (returns false). */
    set(key, value) {
      const generation = generations.get(KeptLRU.segmentOf(key)) ?? 0;
      const taken = super.set(key, value);
      if (taken !== false) this.born.set(key, generation);
      return taken;
    }
    has(key) { if (this.stale(key)) { this.remove(key); return false; } return super.has(key); }
    get(key) { if (this.stale(key)) { this.remove(key); return undefined; } return super.get(key); }
    remove(key) { this.born.delete(key); return super.remove(key); }
  };
}

module.exports = { keptLRU, keyPath, segmentOf };
