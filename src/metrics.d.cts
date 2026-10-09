/** Labels of one series: name → value. */
export type Labels = Record<string, string | number | boolean>;
export interface MetricOptions {
  /** One line on what it measures (Prometheus' HELP). */
  help?: string;
}
export interface HistogramOptions extends MetricOptions {
  /** Upper bounds, in the metric's unit; default: seconds from 0.001 to 60. */
  buckets?: number[];
}
export interface Counter {
  /** Adds 1 (or `n`, never negative). */
  inc(labels?: Labels): void;
  inc(n: number, labels?: Labels): void;
}
export interface Gauge {
  set(value: number, labels?: Labels): void;
  inc(labels?: Labels): void;
  inc(n: number, labels?: Labels): void;
  dec(labels?: Labels): void;
  dec(n: number, labels?: Labels): void;
}
export interface Histogram {
  /** One observation, in base units (seconds, bytes). */
  observe(value: number, labels?: Labels): void;
}
/** A counter: only goes up. Does nothing unless the shell declares zoneConfig({ metrics: true }). */
export declare function counter(name: string, options?: MetricOptions): Counter;
/** A gauge: a value that goes up and down. */
export declare function gauge(name: string, options?: MetricOptions): Gauge;
/** A histogram of observations into cumulative buckets. */
export declare function histogram(name: string, options?: HistogramOptions): Histogram;
/** Runs `fn` and observes its duration in seconds into the histogram `name`, labelled outcome "ok" or "error". */
export declare function time<T>(name: string, fn: () => T, labels?: Labels, options?: HistogramOptions): T;
/** Runs `fn` before each read of the store, to set gauges from the current state. Returns a function that removes it. */
export declare function collect(fn: () => void): () => void;
/** The store as Prometheus' text format; "" with metrics off. */
export declare function render(): string;
/** Whether the shell turned metrics on. */
export declare function enabled(): boolean;
export declare const CONTENT_TYPE: string;
export declare const DEFAULT_BUCKETS: readonly number[];
