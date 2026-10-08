"use strict";
/*
 * A zone's routing rules: its aliases, and its next.config headers, redirects and rewrites.
 *
 * Production computes the router server's route list once, at the first request. So one dispatcher is put in each list
 * (headers, redirects, rewrites before files, after files, fallback) before that request (hooks.cjs); its match() walks
 * the current table of zone rules, and its destination / has / missing / statusCode / headers getters answer for the
 * rule that just matched. Next reads them right after match(), with no await in between (resolve-routes), so concurrent
 * requests never see each other's rule, and Next does the rest: params, has/missing, 307/308, the order (headers and
 * redirects before the shell's proxy, rewrites after it). The tables are replaced whole by the switch.
 * A zone's aliases are rewrites before files, at the root; its own rules must stay under its mount or its aliases.
 */

const LISTS = ["headers", "redirects", "beforeFiles", "afterFiles", "fallback"];

function createRules(ctx) {
  const { getPathMatch } = ctx.requireNext("next/dist/shared/lib/router/utils/path-match");
  ctx.ruleTables = Object.fromEntries(LISTS.map((list) => [list, []]));

  class Dispatcher {
    constructor(list) { this.list = list; this.current = null; }
    match(pathname) {
      for (const rule of ctx.ruleTables[this.list]) {
        const params = rule.match(pathname);
        if (params) { this.current = rule; return params; }
      }
      this.current = null;
      return false;
    }
    get has() { return this.current?.has; }
    get missing() { return this.current?.missing; }
  }
  class RewriteDispatcher extends Dispatcher { get destination() { return this.current?.destination; } }
  class AfterFilesRewriteDispatcher extends RewriteDispatcher { get check() { return true; } }
  class RedirectDispatcher extends RewriteDispatcher {
    get statusCode() { return this.current?.statusCode; }
    get permanent() { return this.current?.permanent; }
  }
  class HeaderDispatcher extends Dispatcher { get headers() { return this.current?.headers; } }
  const dispatchers = {
    headers: new HeaderDispatcher("headers"),
    redirects: new RedirectDispatcher("redirects"),
    beforeFiles: new RewriteDispatcher("beforeFiles"),
    afterFiles: new AfterFilesRewriteDispatcher("afterFiles"),
    fallback: new AfterFilesRewriteDispatcher("fallback"),
  };

  const compileRule = (rule) => ({ ...rule, match: getPathMatch(rule.source, { strict: true, removeUnnamedParams: true }) });
  /** Every given zone's rules, compiled, per list (aliases first among the rewrites before files). */
  function buildRuleTables(zoneList) {
    const tables = Object.fromEntries(LISTS.map((list) => [list, []]));
    for (const z of zoneList) {
      tables.beforeFiles.push(...(z.aliases ?? []).map(compileRule));
      for (const list of LISTS) tables[list].push(...(z.rules?.[list] ?? []).map(compileRule));
    }
    return tables;
  }

  /** Puts the dispatchers in a router server's file-system check, ahead of the shell's own rules. */
  function attach(checker) {
    checker.headers.unshift(dispatchers.headers);
    checker.redirects.unshift(dispatchers.redirects);
    checker.rewrites.beforeFiles.unshift(dispatchers.beforeFiles);
    checker.rewrites.afterFiles.unshift(dispatchers.afterFiles);
    checker.rewrites.fallback.unshift(dispatchers.fallback);
  }

  return { buildRuleTables, attach };
}

module.exports = { createRules };
