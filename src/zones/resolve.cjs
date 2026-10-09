"use strict";
/*
 * One node_modules: a zone's externals resolve from the shell's.
 *
 * A zone's server code requires its externals by bare name ("next/…", "react"), and Turbopack aliases the
 * serverExternalPackages as "<pkg>-<hash>" through absolute symlinks in the build's node_modules/ that point at the
 * build machine. From a zone store elsewhere (a volume, another machine) neither resolves. So a bare request from inside
 * a zone's build resolves against the shell's node_modules first (the hash suffix stripped): every zone gets the
 * shell's single copy of Next, React and every shared package, wherever its build is stored. What the shell lacks
 * resolves from the image itself: an image built with output: "standalone" carries the packages it needs.
 *
 * The same for an ES module a zone's server code imports (Turbopack's runtime loads an external ES module with
 * import(), a Pages Router build leaves most packages external): through Node's module hooks, which see import() as
 * well as require(). Without them, the import would follow the image's link to the build machine.
 */
const Module = require("node:module");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const HASHED_EXTERNAL = /^((?:@[^/]+\/)?[^/@]+)-[0-9a-f]{16}(\/.*)?$/;

function installSharedNodeModules(ctx) {
  const zoneDistOf = (file) => { for (const d of ctx.zoneDists) if (file.startsWith(d)) return d; return null; };
  const shellPaths = Module._nodeModulePaths(ctx.shell);
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent?.filename;
    if (from && !request.startsWith(".") && !path.isAbsolute(request) && !Module.isBuiltin(request) && zoneDistOf(from)) {
      const named = request.replace(HASHED_EXTERNAL, "$1$2");
      try { return resolveFilename.call(this, named, { ...parent, paths: shellPaths }, ...rest); } catch {}
      /* Then the zone image's own packages (an image built with output: "standalone" carries what it needs). */
      if (named !== request) try { return resolveFilename.call(this, named, parent, ...rest); } catch {}
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
  if (typeof Module.registerHooks === "function") {
    const shellParent = pathToFileURL(path.join(ctx.shell, "package.json")).href;
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        /* The cheap tests first: this runs for every require and import of the process. */
        if (!ctx.zoneDists.size || specifier[0] === "." || specifier[0] === "/" || specifier.startsWith("file:") || specifier.startsWith("node:") || !context.conditions?.includes("import")) return nextResolve(specifier, context);
        const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
        if (parent && !path.isAbsolute(specifier) && !Module.isBuiltin(specifier) && zoneDistOf(parent)) {
          const named = specifier.replace(HASHED_EXTERNAL, "$1$2");
          try { return nextResolve(named, { ...context, parentURL: shellParent }); } catch {}
        }
        return nextResolve(specifier, context);
      },
    });
  }
}

module.exports = { installSharedNodeModules };
