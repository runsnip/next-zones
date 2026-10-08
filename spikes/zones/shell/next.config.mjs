import { zoneConfig } from "@runsnip/next-zones/config";

/* The shell: the zone mounted at "/". It declares the URLs Zones serves of its own: the swap events, health, and the
   admin endpoints the checks install through (under the default base, /_next-zones). */
export default zoneConfig({ mount: "/", endpoints: { events: true, health: true, admin: true } });
