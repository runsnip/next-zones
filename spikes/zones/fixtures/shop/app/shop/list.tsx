"use client";
import { useState } from "react";

/* The shop zone's own client component. */
export function List() {
  const [items, setItems] = useState<string[]>([]);
  return <div><button id="add" onClick={() => setItems([...items, `item ${items.length + 1}`])}>add</button><ul id="items">{items.map((i) => <li key={i}>{i}</li>)}</ul></div>;
}
