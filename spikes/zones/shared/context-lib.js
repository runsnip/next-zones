/* A context in a library (no "use client"): what a data library or UI kit ships. A bundler that drops each build's
   unused exports trims it per build: the shell's build uses only the Provider (through context.js), a zone's also
   the hook, so the two builds' copies differ and the zone's hook would read another context. */
import { createContext, createElement, useContext } from "react";

const Label = createContext("none");

export function LabelProvider({ value, children }) {
  return createElement(Label.Provider, { value }, children);
}

export function useLabel() {
  return useContext(Label);
}
