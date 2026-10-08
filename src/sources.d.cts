/** Where zone images are pulled from: writes the zone image's files into `into`, or resolves false. Pass `signal` on. */
export interface ZoneImageSource {
  name: string;
  fetch(request: { zone: string; version: string; into: string; signal?: AbortSignal }): Promise<boolean>;
}
/** Packs a zone image folder (<store>/<zone>/<version>) into a .tgz, or a .zip when outFile ends in .zip; resolves the file path. */
export declare function packZoneImage(dir: string, outFile: string): Promise<string>;
/** Unpacks a .tgz or .zip zone image (a stream, a file path or a Buffer) into `into`, unwrapping one top-level folder;
 * refuses entries that leave the folder. Resolves the bytes written. */
export declare function unpackZoneImage(input: NodeJS.ReadableStream | string | Buffer, into: string, options?: { signal?: AbortSignal }): Promise<number>;
/** Zone images in another folder: <root>/<zone>/<version>/ or <root>/<zone>/<version>.tgz. */
export declare function fromDirectory(root: string): ZoneImageSource;
type Headers = Record<string, string> | ((request: { zone: string; version: string }) => Record<string, string> | Promise<Record<string, string>>);
interface TransferOptions {
  /** A response that sends nothing for this long is dropped (default 30000 ms). */
  stallMs?: number;
  /** A dropped or stalled response is resumed with Range this many times (default 3). */
  retries?: number;
  retryDelayMs?: number;
}
/** Zone images over HTTP as .tgz or .zip; `template` has {zone} and {version}. A 404 means the source does not have it. */
export declare function fromHttp(template: string, options?: TransferOptions & { headers?: Headers; name?: string }): ZoneImageSource;
/** Zone images from service-connector (GET /api/connector/images/<hub>/<owner>/<zone>@<version>), with a bearer token. */
export declare function fromConnector(options: TransferOptions & { origin: string; owner: string; hub?: string; token?: string | ((request: { zone: string; version: string }) => string | Promise<string>) }): ZoneImageSource;
