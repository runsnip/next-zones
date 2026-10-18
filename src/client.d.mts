/** Refreshes an open tab when Zones installs a new version of a zone. Render it once in the root layout; `endpoint` defaults to /_next-zones/events.
    Each swap is also dispatched on window as a "next-zones:swap" CustomEvent ({ zone, version, state }, or null after a
    reconnection to another process), for a page that read <base>/served to read it again. */
export declare function ZoneUpdates(props?: { endpoint?: string }): null;

/** In the shell's not-found page: { zone, state: "stopped" } when the 404 shown is a stopped zone's, else null (also
    before the page hydrates). Read in the browser from the response's Server-Timing, so the page can stay static. */
export declare function useZoneState(): { zone: string | null; state: "stopped" } | null;
