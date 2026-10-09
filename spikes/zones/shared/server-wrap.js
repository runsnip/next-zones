/* The same code in every build, over a dependency that differs between them (server-variant.js): a build must get its
   own dependency through it, not another build's (sharedver.mjs). */
import { variant } from "./server-variant.js";

export function wrapped() {
  return `wrapped ${variant()}`;
}
