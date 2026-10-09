"use client";
import { useState } from "react";
import { leakAction } from "./actions";

/* Calls the server action, so the action is referenced from client code. */
export function LeakButton() {
  const [n, setN] = useState<number | null>(null);
  return <button id="leak-action" onClick={async () => setN(await leakAction("x"))}>action {n ?? "-"}</button>;
}
