import { zoneConfig } from "@runsnip/next-zones/config";

/* A shell with Cache Components ('use cache', PPR): every zone it serves must enable them too. */
export default zoneConfig({ mount: "/", endpoints: { events: true, health: true, admin: true } }, { cacheComponents: true });
