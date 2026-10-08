/* An ISR page of the zone: regenerated at most every second, and written to the active version's cache. */
export const revalidate = 1;

export default function Clock() {
  return <section><h1 id="title">zone clock</h1><p id="at">{new Date().toISOString()}</p></section>;
}
