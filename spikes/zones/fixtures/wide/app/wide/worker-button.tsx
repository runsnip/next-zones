"use client";
import { useState } from "react";

/* Starts the zone's Web Worker and shows its answer (workers.mjs). */
export function WorkerButton() {
  const [reply, setReply] = useState("");
  const start = () => {
    const worker = new Worker(new URL("./echo.worker.ts", import.meta.url));
    worker.onmessage = (event) => { setReply(String(event.data)); worker.terminate(); };
    worker.postMessage("ping");
  };
  return <><button id="start-worker" onClick={start}>worker</button><p id="worker-reply">{reply}</p></>;
}
