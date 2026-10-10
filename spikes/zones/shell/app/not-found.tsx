"use client";
import { useZoneState } from "@runsnip/next-zones/client";

/* The shell's not-found, for every URL outside the zones and for a zone without its own: Next's text, and, for a
   stopped zone's URL, what Zones says of it (useZoneState, read in the browser: the page stays static; stop.mjs). */
export default function NotFound() {
  const zone = useZoneState();
  return (
    <div>
      <h1>404: This page could not be found.</h1>
      {zone ? <p id="zone-state">{zone.zone} is {zone.state}</p> : null}
    </div>
  );
}
