/* blog's instrumentation: register() and onRequestError() leave a trace Zones' debug endpoint reports. */
type Trace = { who: string; event: string; route?: string };
const log = (entry: Trace) => {
  const g = globalThis as { __instrumentationLog?: Trace[] };
  (g.__instrumentationLog ??= []).push(entry);
};

export function register() {
  log({ who: "blog", event: "register" });
}

export function onRequestError(_error: unknown, _request: unknown, context: { routePath?: string }) {
  log({ who: "blog", event: "error", route: context.routePath });
}
