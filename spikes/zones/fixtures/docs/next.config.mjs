import { zoneConfig } from "@runsnip/next-zones/config";

/* A zone on the Pages Router: its own _app and _document, static pages, getStaticProps (with paths and ISR) and
   getServerSideProps. ZONE_VERSION is inlined, so two builds differ the way two releases would. */
const version = process.env.ZONE_VERSION ?? "1";

export default zoneConfig({ mount: "/docs", env: { ZONE_VERSION: version } });
