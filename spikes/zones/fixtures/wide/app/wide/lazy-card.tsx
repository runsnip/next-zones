"use client";
import { useLabel } from "@spike/shared/context-lib";

/* Loaded only by LazyButton's import(): JSX (React's runtime, the shell's module under another id) and the context the
   root layout provides. */
export function LazyCard() {
  return <p id="lazy">lazy card, context {useLabel()}</p>;
}
