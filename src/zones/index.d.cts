import type { IncomingMessage, ServerResponse, Server } from "node:http";

declare namespace nextZonesZones {
  interface ZonesOptions {
    /** The shell's directory: its next.config uses zoneConfig({ mount: "/" }). */
    shell: string;
    /** The zone store: <store>/<zone>/<version>/ (next-zones build). */
    store?: string;
    /** Writable: each zone image's ISR cache and analysis. */
    cacheDir?: string;
    /** The URLs Zones serves of its own, over the shell's zoneConfig declaration; false for none. */
    endpoints?: { base?: string; events?: boolean; health?: boolean; admin?: boolean } | false;
    /** Zones' MCP server, over the shell's zoneConfig({ mcp }); false: none. */
    mcp?: import("../mcp.d.cts").McpServer | false;
    /** Where zone images are pulled from, tried in order (see @runsnip/next-zones/sources): the only way one enters the store. */
    sources?: { name: string; fetch(request: { zone: string; version: string; into: string; signal?: AbortSignal }): Promise<boolean> }[];
    /** Old zone images removed after each pull and install (default { keep: 2, auto: true }); false: never. */
    prune?: { keep?: number; auto?: boolean } | false;
    /** Bytes a pull leaves free on the store's disk (default 1 GiB). */
    minFree?: number;
    /** After a version is collected, V8's last-resort collection once Zones is idle (default { idleMs: 1000, maxWaitMs: 30000 }); false: never. */
    reclaim?: { idleMs?: number; maxWaitMs?: number } | false;
    /** Zone → version installed at boot; the store's state.json is read over them unless they are newer (pinsAt). */
    pins?: Record<string, string>;
    /** When the pins were written (ms since the epoch): pins newer than the store's state replace it at boot. */
    pinsAt?: number;
    /** Default true: state.json keeps the active versions across restarts. */
    persist?: boolean;
    /** Instrumentation policy. */
    policy?: { instrumentation?: { shell?: { skip?: string[] }; own?: Record<string, boolean> } };
    /** Required by the admin endpoints unless the request is local. */
    adminToken?: string;
    /** Refuse a zone whose client modules differ from the shell's copies of them and may hold state (two copies of a
        context); by default the install reports them in `warnings`. */
    strictModules?: boolean;
    /** Enables <base>/debug and <base>/bench (with endpoints declared). */
    debug?: boolean;
    scopedLoaders?: boolean;
    moduleRegistry?: boolean;
  }
  /** A zone and its state, as zones() (and <base>/zones, the MCP tool zones_status) tell it. */
  type ZoneState =
    | {
        /** serving: its URLs are served. stopped: they answer 404 (x-next-zones-state: stopped); it stays installed. */
        state: "serving" | "stopped";
        version: string;
        mount: string;
        /** Its aliases' sources. */
        aliases: string[];
        livePull: boolean;
        /** When it last started serving, or stopped (ISO time). */
        since: string | null;
        /** The version installed before this one, the target of a rollback. */
        previous: string | null;
      }
    /** It failed to install at boot (and was not installed since). */
    | { state: "failed"; version: string; error: string }
    /** Images in the store, never installed. */
    | { state: "available"; versions: string[] };
  interface StopResult {
    name: string;
    version: string;
    state: "serving" | "stopped";
    /** false when the zone was in that state already. */
    changed: boolean;
    /** The switch, in ms. */
    ms?: number;
  }
  interface InstallResult {
    /** The source the version was pulled from, when the store lacked it. */
    pulledFrom?: string;
    name: string;
    version: string;
    /** "stopped" when the zone is stopped: the version is installed and serves once the zone is resumed. */
    state: "serving" | "stopped";
    routes: string[];
    ms: number;
    blockedMs: number;
    t: Record<string, number>;
  }
  interface PruneResult {
    /** "zone@version" removed from the store. */
    removed: string[];
    /** Kept until a restart: other versions share modules they loaded first. */
    held: string[];
    kept: { zone: string; version: string; why: string }[];
    freedBytes: number;
    /** Folders left by a crashed pull or prune, removed. */
    leftovers: number;
  }
  interface Zones {
    listen(port?: number, hostname?: string): Promise<Server>;
    prepare(port?: number, hostname?: string): Promise<void>;
    handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    install(name: string, version: string): Promise<InstallResult>;
    pull(name: string, version: string): Promise<{ name: string; version: string; pulledFrom: string | null }>;
    prune(options?: { keep?: number; dryRun?: boolean }): Promise<PruneResult>;
    collect(options?: { keep?: number }): Promise<{ removed: string[]; pinned: string[]; kept: string[] }>;
    boot(): Record<string, { version: string; ok: boolean; error?: string }>;
    /** Every zone and its state. */
    zones(): Record<string, ZoneState>;
    /** Stops a zone: its URLs answer 404, marked x-next-zones-state: stopped and x-next-zones-zone; it stays installed. */
    stop(name: string): Promise<StopResult>;
    /** Resumes a stopped zone, with no install. */
    resume(name: string): Promise<StopResult>;
    close(): Promise<void>;
  }
}

/** Zones: one per process, created before anything else requires Next. */
declare function createZones(options: nextZonesZones.ZonesOptions): nextZonesZones.Zones;

export { createZones };
export type ZonesOptions = nextZonesZones.ZonesOptions;
export type Zones = nextZonesZones.Zones;
export type PruneResult = nextZonesZones.PruneResult;
export type ZoneState = nextZonesZones.ZoneState;
export type StopResult = nextZonesZones.StopResult;
