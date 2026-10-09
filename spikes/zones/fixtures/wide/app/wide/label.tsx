"use client";
import { useLabel } from "@spike/shared/context-lib";

/* Reads the context the root layout provides (shared/context-lib.js). */
export function ContextLabel() {
  return <p id="context-label">context {useLabel()}</p>;
}
