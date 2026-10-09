import { counter, time } from "@runsnip/next-zones/metrics";

export const dynamic = "force-dynamic";

const views = counter("blog_metric_views_total", { help: "Views of the metric page (metrics.mjs)" });

/* A zone's code measuring for itself: a counter and a timed piece of work, into the shell's metrics store. */
export default async function MetricPage() {
  views.inc({ page: "metric" });
  const sum = await time("blog_metric_work_seconds", async () => [1, 2, 3].reduce((a, b) => a + b, 0), { step: "sum" });
  return <section><h1 id="title">zone blog metric</h1><p id="sum">{sum}</p></section>;
}
