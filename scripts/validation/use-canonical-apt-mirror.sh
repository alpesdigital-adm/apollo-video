#!/usr/bin/env bash
# Points the runner's apt at the Canonical archive instead of the Azure mirror the GitHub image ships with, and bounds every fetch.
#
# On 23/10/2026 the Azure mirror (azure.archive.ubuntu.com) served `apt-get install ffmpeg` in 35–40 minutes instead of ~16 s, and
# every job that installs distribution packages ran out of its time budget before a single test failed. The packages are the same
# distribution packages either way (same archive, same versions, same signatures), so the parity with the deployment image that
# the install steps exist for is unchanged; only where the bytes come from changes.
set -euo pipefail

# The Canonical archive carries every suite the image lists (release, updates, backports and security), so only the host changes.
# The runner image lists its sources as `URIs: mirror+file:/etc/apt/apt-mirrors.txt`, so the Azure host lives in that mirror list
# rather than in the sources files; both places are rewritten.
changed=0
for file in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$file" ] || continue
  if grep -q 'azure\.archive\.ubuntu\.com' "$file"; then
    sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$file"
    changed=$((changed + 1))
  fi
done

# A stalled connection is retried instead of holding the step until the job's timeout.
printf '%s\n' \
  'Acquire::Retries "5";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  | sudo tee /etc/apt/apt.conf.d/80-apollo-ci-fetch >/dev/null

echo "apt sources rewritten to the Canonical archive in ${changed} file(s)"
grep -h -E '^(deb |URIs:)' /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | sort -u || true
[ -f /etc/apt/apt-mirrors.txt ] && sed -n '1,5p' /etc/apt/apt-mirrors.txt
# Nothing left pointing at the Azure mirror: a layout this script does not know fails here instead of silently keeping the slow host.
if grep -rqs 'azure\.archive\.ubuntu\.com' /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/; then
  echo 'apt still points at azure.archive.ubuntu.com after the rewrite' >&2
  exit 1
fi
