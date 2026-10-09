"use client";
/*
 * <ZoneUpdates />: render it once in the shell's root layout. It listens to Zones' swap events and refreshes the
 * router, so an open tab drops its cached payloads and its next navigation renders the version just installed.
 * A zone on the Pages Router renders it in its own _app: its pages run in documents of their own, under the zone's
 * build, so after a swap the tab's next navigation (a link, router.push, back or forward) loads a new document, which
 * is the version just installed; nothing reloads before the user navigates.
 * It needs the shell to declare the events endpoint (zoneConfig({ mount: "/", endpoints: { events: true } })); with
 * another endpoints.base, pass endpoint="<base>/events". Where there is no event stream (a zone running alone, no
 * events declared), it does nothing.
 * Importing this module also gives the shell's browser runtime every feature a zone's code may use (runtime-features.mjs).
 */
import { useEffect } from "react";
/* With its extension: a Pages Router build leaves this package external, and Node's ESM loader finds next/ files only
   by their full name (Next has no exports map). */
import { useRouter } from "next/navigation.js";

/* The shell's Turbopack runtime with every feature a zone may use (runtime-features.mjs): an import that never runs. */
if (globalThis.__NEXT_ZONES_NEVER__ === true) import("./runtime-features.mjs");

export function ZoneUpdates({ endpoint = "/_next-zones/events" }) {
  const router = useRouter();
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource(endpoint);
    /* A Pages Router document (it has __NEXT_DATA__ and the pages router on window.next) or an App Router one. */
    const pages = typeof window !== "undefined" && window.__NEXT_DATA__ && window.next?.router;
    const onSwap = pages ? () => navigateWithNewDocuments(pages) : () => router.refresh();
    events.addEventListener("swap", onSwap);
    events.onerror = () => { if (events.readyState === EventSource.CLOSED) events.close(); };
    return () => { events.removeEventListener("swap", onSwap); events.close(); };
  }, [endpoint, router]);
  return null;
}

/* After a swap, the Pages Router's navigations load new documents: router.push and replace (which <Link> calls) go
   to the URL with the browser, and back or forward reload the entry. */
function navigateWithNewDocuments(router) {
  if (router.__nextZonesStale) return;
  router.__nextZonesStale = true;
  const target = (url, as) => {
    const to = as ?? url;
    if (typeof to === "string") return to;
    const query = new URLSearchParams(Object.entries(to.query ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString();
    return `${to.pathname ?? ""}${query ? `?${query}` : ""}${to.hash ? `#${to.hash.replace(/^#/, "")}` : ""}`;
  };
  router.push = (url, as) => { window.location.assign(target(url, as)); return new Promise(() => {}); };
  router.replace = (url, as) => { window.location.replace(target(url, as)); return new Promise(() => {}); };
  router.prefetch = () => Promise.resolve();
  router.beforePopState(() => { window.location.reload(); return false; });
}
