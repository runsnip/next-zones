"use client";
/* A client component shared by the shell and every zone: each evaluation in the browser is counted. A build that sets
   env.BADGE_VARIANT (shop v2) has another version of it: same module path, so the same module id, different code. */
import { createElement } from "react";

if (typeof window !== "undefined") window.__sharedClientEvals = (window.__sharedClientEvals ?? 0) + 1;

export function Badge({ label }) {
  return createElement("span", { id: `badge-${label}` }, `badge ${process.env.BADGE_VARIANT ? `${process.env.BADGE_VARIANT} ` : ""}${label}`);
}
