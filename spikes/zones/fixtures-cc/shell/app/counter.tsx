"use client";
import { useState } from "react";

export function Counter() {
  const [n, setN] = useState(0);
  return <button id="count" onClick={() => setN(n + 1)}>clicked {n}</button>;
}
