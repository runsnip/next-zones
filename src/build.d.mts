/** Builds one version of a zone into a zone store; resolves to the store folder of that version. */
export declare function buildZone(options: {
  zonesDir: string;
  zone: string;
  version?: string;
  store?: string;
  quiet?: boolean;
}): Promise<string>;

/** The version an image of the zone in `dir` is built as: `version`, else its package.json version. */
export declare function zoneVersion(dir: string, version?: string): string;
/**
 * `next-zones build`: the whole workspace (the shell as an app, every zone as an image, zones.json pins), or only the
 * named zones' images. A version already built is kept (whole workspace) or refused (named zones).
 */
export declare function buildWorkspace(options: {
  dir?: string;
  zones?: string[];
  version?: string;
  store?: string;
  /** Also pack each image into <out>/<zone>/<version>.tgz (and leave it out of the store). */
  pack?: boolean;
  /** "tgz" (default) or "zip" (service-connector's store format). */
  format?: "tgz" | "zip";
  /** Default <dir>/.zones-images. */
  out?: string;
  quiet?: boolean;
  log?: (line: string) => void;
}): Promise<{
  /** "single": the workspace built as one Next app, in `app` (mode "single" in the shell's zoneConfig). */
  mode: "zones" | "single";
  app?: string;
  shell: string | null;
  images: { zone: string; version: string; built: boolean; dir?: string; tgz?: string }[];
  pins: string | null;
}>;
