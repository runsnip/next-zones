import type { NextConfig } from "next";

/** A URL at the root that a zone serves, from a page under its mount. */
export interface ZoneAlias {
  source: string;
  destination: string;
}

/** A zone's declaration: "/" for the shell, else one URL segment such as "/blog". */
export interface Zone {
  mount: string;
  aliases?: ZoneAlias[];
  /** Whether a ping to Zones may make it pull this zone's images from its sources. Off by default. */
  livePull?: boolean;
  /** The shell only: the URLs a Zones service serves of its own, none unless declared. */
  endpoints?: ZoneEndpoints | false;
  /**
   * The shell only: how the workspace is served. "zones" (default): the shell as an app, every other zone as an image
   * Zones installs while it runs. "single": every zone in one Next app, run by next start. Next's own options, `output`
   * included, go in the Next config and are honoured in both.
   */
  mode?: "zones" | "single";
  /**
   * The shell only: opens the metrics store for the whole Zones process (requests, installs, memory; and what a zone's
   * code writes with `@runsnip/next-zones/metrics`), served as Prometheus text at <base>/metrics to an admin. Off by
   * default; off, the metrics functions do nothing.
   */
  metrics?: boolean;
  /**
   * The shell only: Zones as an MCP server, made with Mcp({ tools, skills, auth }) from `@runsnip/next-zones/mcp`, at
   * its own path whatever endpoints are declared.
   */
  mcp?: import("./mcp.d.cts").McpServer;
}

/** The URLs a Zones service serves of its own, under one base path; each group off unless set. */
export interface ZoneEndpoints {
  /** Default "/_next-zones". */
  base?: string;
  /** The swap events <ZoneUpdates /> listens to: GET <base>/events. */
  events?: boolean;
  /** For a supervisor: GET <base>/health. */
  health?: boolean;
  /** Behind the admin token: <base>/images/*, <base>/prune, <base>/collect, <base>/policy. */
  admin?: boolean;
}

export declare const DEFAULT_ENDPOINTS_BASE: "/_next-zones";

type ConfigFunction = (phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>;

/**
 * A zone's Next config with its zone declaration, in one object: zoneConfig({ mount: "/blog", ...nextConfig }). The
 * declaration's keys are taken out; every other key is Next's.
 */
export declare function zoneConfig(options: Zone & NextConfig): NextConfig;
/** A Next config that is a function of the phase comes second, so the declaration is known without calling it. */
export declare function zoneConfig(zone: Zone, nextConfig: ConfigFunction): ConfigFunction;
/** Read too: the declaration and an object Next config apart. */
export declare function zoneConfig(zone: Zone, nextConfig: NextConfig): NextConfig;
/** Checks a zone declaration and returns it normalised; throws on an invalid one. */
export declare function checkZone(zone: Zone, where?: string): Required<Zone>;
/** The zone declaration of the app in `dir`, or null when its next.config does not use zoneConfig. */
export declare function readZone(dir: string): Promise<Required<Zone> | null>;
/** The Turbopack options a build for Zones needs; zoneConfig fills them in there only, where unset (configuration.md, "Build options for Zones"). */
export declare const BUILD_OPTIONS: {
  readonly turbopackScopeHoisting: false;
  readonly turbopackRemoveUnusedExports: false;
  readonly turbopackRemoveUnusedImports: false;
};
