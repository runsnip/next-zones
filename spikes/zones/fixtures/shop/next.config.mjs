import { zoneConfig } from "@runsnip/next-zones/config";

/* Version 2 is built against another version of the shared badge (env.BADGE_VARIANT is inlined into it).
   Its build id is a constant git SHA (a generateBuildId), the same for both versions and not the shell's 21-character
   nanoid: Zones names what it derives from a build by its build key, and rewrites the payloads' row lengths. */
const version = process.env.ZONE_VERSION ?? "1";

export default zoneConfig({ mount: "/shop" }, {
  generateBuildId: async () => "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
  ...(version === "2" ? { env: { BADGE_VARIANT: "v2" } } : {}),
});
