"use strict";
/*
 * Per-render module loaders.
 *
 * Next's page runtime assigns globalThis.__next_require__ and __next_chunk_load__ to the rendering page's loaders at
 * the start of every render. With one app that is harmless; with several builds in one process, two concurrent renders
 * (a shell page regenerating in the background while a zone page renders) overwrite each other, and one loads its
 * chunks through the other's runtime: ChunkLoadError, and the regeneration fails. Each global becomes a property whose
 * setter binds the loader to the current async context, and whose getter returns that context's.
 */
const { AsyncLocalStorage } = require("node:async_hooks");

function installScopedLoaders(ctx) {
  if (ctx.options.scopedLoaders === false) return;
  for (const name of ["__next_require__", "__next_chunk_load__"]) {
    const scoped = new AsyncLocalStorage();
    let last;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { return scoped.getStore() ?? last; },
      set(loader) { last = loader; scoped.enterWith(loader); },
    });
  }
}

/*
 * Per-request client reference manifests.
 *
 * Next registers the client reference manifest of the route a request renders in a process-wide map keyed by route
 * (app-render/manifests-singleton: clientReferenceManifestsPerRoute, "/blog" → manifest), set again by every request,
 * and the render reads it back through that map. Two versions of a zone serve the same routes: while a swap is under
 * way, a v1 render can read the manifest a v2 request has just registered for "/blog", and fail ("Could not find the
 * module …blog@1… in the React Client Manifest": 22-136 errors in a swapload run under load). The map Next creates is
 * given a layer per request: what a request registers, it reads back; outside a request, the shared map as before.
 */
function installScopedManifests(ctx) {
  if (ctx.options.scopedLoaders === false) return;
  const request = new AsyncLocalStorage();
  ctx.requestScope = (fn) => request.run(new Map(), fn);
  const scope = (perRoute) => {
    if (!(perRoute instanceof Map) || perRoute.__nextZonesScoped) return;
    const { get, set, has } = Map.prototype;
    Object.defineProperties(perRoute, {
      __nextZonesScoped: { value: true },
      set: { value(route, entry) { request.getStore()?.set(route, entry); return set.call(this, route, entry); } },
      get: { value(route) { const own = request.getStore(); return own?.has(route) ? own.get(route) : get.call(this, route); } },
      has: { value(route) { return request.getStore()?.has(route) || has.call(this, route); } },
    });
  };
  const KEY = Symbol.for("next.server.manifests");
  let singleton = globalThis[KEY];
  if (singleton) scope(singleton.clientReferenceManifestsPerRoute);
  Object.defineProperty(globalThis, KEY, {
    configurable: true,
    get() { return singleton; },
    set(value) { singleton = value; scope(value?.clientReferenceManifestsPerRoute); },
  });
}

module.exports = { installScopedLoaders, installScopedManifests };
