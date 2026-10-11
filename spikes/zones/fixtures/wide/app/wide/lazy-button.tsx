"use client";
import { useState, type ComponentType } from "react";

/* A dynamic import from a client chunk Zones writes again (this zone's ids are wider than the shell's, so its modules
   are aliased to the shell's ids): the loader's list of chunks must name the chunk written again (asyncchunks.mjs). */
export function LazyButton() {
  const [Card, setCard] = useState<ComponentType | null>(null);
  return (
    <>
      <button id="load-lazy" onClick={() => import("./lazy-card").then((m) => setCard(() => m.LazyCard))}>load</button>
      {Card ? <Card /> : null}
    </>
  );
}
