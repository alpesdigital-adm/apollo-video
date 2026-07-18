#!/usr/bin/env bash
set -euo pipefail

DATABASE="${APOLLO_DATABASE:-apollo_video_v2}"
BACKUP_ROOT="${APOLLO_BACKUP_ROOT:-/opt/backups/apollo-video}"
RETENTION_DAYS="${APOLLO_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PARTIAL="${BACKUP_ROOT}/${DATABASE}-${STAMP}.dump.partial"
FINAL="${PARTIAL%.partial}"

install -d -m 700 -o postgres -g postgres "${BACKUP_ROOT}"
sudo -u postgres pg_dump --format=custom --compress=6 --file="${PARTIAL}" "${DATABASE}"
mv "${PARTIAL}" "${FINAL}"
chmod 600 "${FINAL}"

find "${BACKUP_ROOT}" -maxdepth 1 -type f -name "${DATABASE}-*.dump" \
  -mtime "+${RETENTION_DAYS}" -delete

printf '%s\n' "${FINAL}"
