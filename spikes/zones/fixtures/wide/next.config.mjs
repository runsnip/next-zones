import { zoneConfig } from "@runsnip/next-zones/config";
import "./app/wide/generate.mjs";

/* A zone with over a thousand client modules: Turbopack cuts its module ids to more digits than the shell's
   (widths.mjs). */
export default zoneConfig({ mount: "/wide" });
