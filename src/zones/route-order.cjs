"use strict";
/*
 * Next's order of dynamic routes (getSortedRoutes, shared/lib/router/utils/sorted-routes), as a comparator, so a
 * sorted list can take a zone's routes by a merge (O(n)) instead of being sorted again (a trie over every route).
 *
 * getSortedRoutes inserts every path into a trie and reads it back depth first; at each node: the node's own route,
 * then its static children in string order, then its [slug] child, then [...rest], then [[...optional]]. Compared
 * segment by segment, that is: a path that ends first comes first; a static segment before [slug] before [...rest]
 * before [[...optional]]; two static segments by string order; two slugs of one kind are the same node (Next
 * refuses two slug names at one place), so the next segment decides. test/route-order.test.mjs checks it against
 * getSortedRoutes itself on generated route sets.
 */
const segmentsOf = new Map();                          // path → its segments, kept: paths come back on every install
const segments = (path) => {
  let s = segmentsOf.get(path);
  if (!s) { s = path.split("/").filter(Boolean); segmentsOf.set(path, s); }
  return s;
};
const kind = (seg) => (seg.startsWith("[[...") ? 3 : seg.startsWith("[...") ? 2 : seg.startsWith("[") ? 1 : 0);

/** Next's order of two route paths: < 0 when `a` comes first. */
function compareRoutes(a, b) {
  if (a === b) return 0;
  const A = segments(a), B = segments(b);
  for (let i = 0; ; i++) {
    if (i === A.length) return i === B.length ? 0 : -1;
    if (i === B.length) return 1;
    const ka = kind(A[i]), kb = kind(B[i]);
    if (ka !== kb) return ka - kb;
    if (ka === 0 && A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
}

/**
 * Two lists already in Next's order, merged into one: `key` gives an item's path. On equal paths, `base`'s items come
 * first (as grouping by path, base first, did).
 */
function mergeSorted(base, added, key) {
  const out = new Array(base.length + added.length);
  let i = 0, j = 0, k = 0;
  while (i < base.length && j < added.length) out[k++] = compareRoutes(key(added[j]), key(base[i])) < 0 ? added[j++] : base[i++];
  while (i < base.length) out[k++] = base[i++];
  while (j < added.length) out[k++] = added[j++];
  return out;
}

module.exports = { compareRoutes, mergeSorted };
