#!/usr/bin/env bash
set -euo pipefail
# Resolution only; exec transfers foreground ownership to normal Node.
test "$(id -u)" -ne 0
test "$(uname -s)" = Linux
test -n "${RUNNER_TEMP:?RUNNER_TEMP required}"
test -n "${GITHUB_ENV:?GITHUB_ENV required}"
test -n "${GITHUB_SHA:?source SHA required}"
node_binary="$(readlink -f "$(command -v node)")"
compiler="$(readlink -f "$(command -v cc)")"
timeout_binary="$(readlink -f "$(command -v timeout)")"
headers="$(dirname "$(dirname "$node_binary")")/include/node"
exec "$node_binary" scripts/validation/build-perception-pidfd.mjs "$compiler" "$timeout_binary" "$headers"
