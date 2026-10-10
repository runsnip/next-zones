import { zoneConfig } from "@runsnip/next-zones/config";
import { Mcp, Tools, Tool, LivePull, Metrics, Skills, NextZonesSkill } from "@runsnip/next-zones/mcp";

/* The shell: the zone mounted at "/". It declares the URLs Zones serves of its own: the swap events, health, and the
   admin endpoints the checks install through (under the default base, /_next-zones). And Zones' MCP server, at
   /_next-zones/mcp whatever endpoints are on: Zones' own tools, one of the shell's (reading Zones, as it declares),
   and next-zones' skill. No auth declared: the admin rule (a request from this machine, the checks'). */
export default zoneConfig({
  mount: "/",
  endpoints: { events: true, health: true, admin: true },
  metrics: true,
  mcp: Mcp({
    tools: Tools(
      LivePull(),
      Metrics(),
      Tool({
        name: "shell_versions",
        description: "The version each zone serves, as the shell's own tool sees it.",
        input: { type: "object", properties: { zone: { type: "string" } } },
        zones: ["read"],
        handler: ({ zone }, { zones }) => {
          const active = zones.status().zones;
          return zone ? { [zone]: active[zone] ?? null } : active;
        },
      }),
    ),
    skills: Skills(NextZonesSkill()),
  }),
});
