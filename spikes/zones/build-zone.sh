#!/bin/sh
# Builds a test zone image into this spike's store: ./build-zone.sh blog 2  →  .zones-store/blog/2/
# The tool itself is tools/build-zone.mjs.
# The package is installed here as a copy (install-links), so the copy is brought up to date with src/ first.
cd "$(dirname "$0")" && cp -R ../../src/. node_modules/@runsnip/next-zones/src/ && exec node ../../tools/build-zone.mjs fixtures "$1" "${2:-1}" --store .zones-store
