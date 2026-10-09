#!/bin/sh
# Builds a test zone image into this spike's store: ./build-zone.sh blog 2  →  .zones-store/blog/2/
# The tool itself is tools/build-zone.mjs.
# The package is installed here as a copy (install-links), so the copy is brought up to date first: dist/, built from src/.
cd "$(dirname "$0")" && node ../../tools/build-dist.mjs > /dev/null && rm -rf node_modules/@runsnip/next-zones/src node_modules/@runsnip/next-zones/dist && mkdir -p node_modules/@runsnip/next-zones/dist && cp -R ../../dist/. node_modules/@runsnip/next-zones/dist/ && cp ../../package.json node_modules/@runsnip/next-zones/package.json && exec node ../../tools/build-zone.mjs fixtures "$1" "${2:-1}" --store .zones-store
