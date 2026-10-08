"use client";

/* The zone's error boundary for /blog/broken. */
export default function BrokenError({ reset }: { error: Error; reset: () => void }) {
  return <div><p id="error-boundary">zone blog error boundary</p><button onClick={reset}>retry</button></div>;
}
