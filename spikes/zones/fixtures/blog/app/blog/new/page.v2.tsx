/* A route that version 2 adds: present after a swap to v2, gone again on a rollback to v1. */
export default function New() {
  return <h1 id="title">zone blog new in v2</h1>;
}
