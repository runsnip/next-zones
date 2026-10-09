import { zoneConfig } from "@runsnip/next-zones/config";

/* A second zone on the Pages Router, with an _app and a _document of its own: composed with docs by next-zones dev,
   each page renders with its own zone's. */
export default zoneConfig({ mount: "/wiki" });
