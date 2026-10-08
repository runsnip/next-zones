#!/bin/sh
# The CLI end to end: serve with an admin token, install with and without it, restart, and the version survives.
set -e
cd "$(dirname "$0")"
STORE=$(mktemp -d); cp -R .zones-store/blog .zones-store/shop "$STORE"/
CLI=../../src/cli.mjs
export NEXT_ZONES_ADMIN_TOKEN=secret-for-the-check
start() { node $CLI serve --shell shell --store "$STORE" --port 3902 --host 127.0.0.1 > persist.log 2>&1 & PID=$!; for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:3902/ && return; sleep 0.25; done; }
start
echo "first boot: $(grep -c 'blog' persist.log) zones listed"
node $CLI install blog 2 --zones http://127.0.0.1:3902
echo "without the token: $(curl -s -o /dev/null -w '%{http_code}' -XPOST 'http://127.0.0.1:3902/_next-zones/images/blog/1/install')"
cat "$STORE/state.json" | tr -d '\n '; echo
kill $PID; sleep 1
start
echo "after a restart: $(grep 'blog' persist.log | tr -s ' ')"
echo "/blog title: $(curl -s http://127.0.0.1:3902/blog | grep -oE 'zone blog v(<!-- -->)?[0-9]' | head -1)"
kill $PID; rm -rf "$STORE"
