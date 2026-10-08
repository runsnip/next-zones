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

/** Wraps a zone's Next config with its zone declaration and what next-zones needs. */
export declare function zoneConfig(zone: Zone, nextConfig?: NextConfig): NextConfig;
export declare function zoneConfig(zone: Zone, nextConfig: ConfigFunction): ConfigFunction;
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
