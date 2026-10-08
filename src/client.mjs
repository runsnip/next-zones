"use client";
/*
 * <ZoneUpdates />: render it once in the shell's root layout. It listens to Zones' swap events and refreshes the
 * router, so an open tab drops its cached payloads and its next navigation renders the version just installed.
 * It needs the shell to declare the events endpoint (zoneConfig({ mount: "/", endpoints: { events: true } })); with
 * another endpoints.base, pass endpoint="<base>/events". Where there is no event stream (a zone running alone, no
 * events declared), it does nothing.
 * Importing this module also gives the shell's browser runtime every feature a zone's code may use (runtime-features.mjs).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/* The shell's Turbopack runtime with every feature a zone may use (runtime-features.mjs): an import that never runs. */
if (globalThis.__NEXT_ZONES_NEVER__ === true) import("./runtime-features.mjs");

export function ZoneUpdates({ endpoint = "/_next-zones/events" }) {
  const router = useRouter();
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource(endpoint);
    const onSwap = () => router.refresh();
    events.addEventListener("swap", onSwap);
    events.onerror = () => { if (events.readyState === EventSource.CLOSED) events.close(); };
    return () => { events.removeEventListener("swap", onSwap); events.close(); };
  }, [endpoint, router]);
  return null;
}
