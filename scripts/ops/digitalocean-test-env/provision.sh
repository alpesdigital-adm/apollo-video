#!/usr/bin/env bash
# Provisioning of the Apollo disposable TEST ENVIRONMENT on a fresh DigitalOcean droplet (Ubuntu 24.04, run as root).
#
# What it builds is the host the CI "Quality and security" job runs on, plus the private OpenVINO runtime the MP4 pixel critic and the
# V9 face worker need: Node 22, Docker, PostgreSQL 16 + pgvector (container on 127.0.0.1:5432), the PostgreSQL 16 server/client
# binaries (system service disabled), the MinIO image built from source, ffmpeg + fonts-liberation, the Playwright Chromium, Python 3.12
# with the pinned operations venv, the repo checkout with its dependencies and builds, and /opt/apollo/env/test-env.sh.
#
# It is idempotent: every phase checks before it acts, so it can be re-run after a failure. No secret is written anywhere: the only
# credentials are the throw-away test ones the CI itself uses (apollo/apollo-ci, apollo-ci-storage/...-password). Secrets of real
# providers (Groq etc.) are injected per process at test time, never into a file on this host.
#
#   provision.sh [phase ...]          phases: system node docker infra repo deps oracle envfile   (default: all, in that order)
#
# Environment (all optional):
#   APOLLO_REPO_URL            default https://github.com/alpesdigital-adm/apollo-video.git
#   APOLLO_REPO_REF            branch, tag or commit to check out detached (default origin/main)
#   APOLLO_MODEL_SOURCE_DIR    directory holding the four OMZ model files and the retail LICENSE (default /opt/apollo/incoming/models):
#                              face-detection-0204.{xml,bin}, face-detection-retail-0004.{xml,bin}, LICENSE. Copied from the owner
#                              machine (see the runbook); verified against the SHA-256 pins below.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

APOLLO_ROOT=/opt/apollo
REPO_URL="${APOLLO_REPO_URL:-https://github.com/alpesdigital-adm/apollo-video.git}"
REPO_REF="${APOLLO_REPO_REF:-origin/main}"
REPO_DIR="$APOLLO_ROOT/apollo-video"
ENV_DIR="$APOLLO_ROOT/env"
MODEL_SRC="${APOLLO_MODEL_SOURCE_DIR:-$APOLLO_ROOT/incoming/models}"
MODEL_DIR="$APOLLO_ROOT/models"
ORACLE_VENV="$APOLLO_ROOT/venv-oracle"
ORACLE_PYDEPS="$APOLLO_ROOT/oracle-pydeps"
OPS_VENV="$APOLLO_ROOT/venv-ops"
BROWSERS_DIR="$APOLLO_ROOT/ms-playwright"
NODE_MAJOR=22

# Pins (config/platform-versions.json and src/v2/domain/pixel-face-oracle.ts are the source of truth; verified again at the end).
PG_IMAGE="pgvector/pgvector:0.8.5-pg16-trixie"
OPENVINO_VERSION="2026.4.0"
OPENCV_VERSION="4.13.0"
NUMPY_VERSION="2.5.1"
SHA_V9_XML=33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3
SHA_V9_BIN=0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102
SHA_RETAIL_XML=90922d199016d18128bdaba488bdb1628fce50efcc81155ede7949cbba3dd979
SHA_RETAIL_BIN=89349ce12dd21c5263fb302cd3ffd4b73c35ea12ed98aff863d03a2cf3a32464
SHA_LICENSE=c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4

log() { printf '\n==== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
need_root() { [ "$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }

phase_system() {
  log 'system: no unattended package changes during the work, swap, base packages'
  systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
  systemctl mask unattended-upgrades.service apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
  # a running apt/dpkg from the first boot must finish before ours starts
  for _ in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 5; done
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gnupg git jq tmux unzip xz-utils build-essential pkg-config \
    python3 python3-venv python3-pip \
    ffmpeg fonts-liberation \
    postgresql-16 postgresql-client-16 \
    docker.io docker-compose-v2
  # PostgreSQL 16 binaries are needed by the isolated activity proof; the system cluster must NOT hold 5432.
  systemctl disable --now postgresql.service 'postgresql@16-main.service' 2>/dev/null || true
  if ! swapon --show | grep -q /swapfile; then
    [ -f /swapfile ] || { fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  # The CI builds and tests as an unprivileged user with passwordless sudo and docker access (the pidfd addon build refuses uid 0).
  id apollo >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker apollo
  usermod -aG docker apollo
  printf 'apollo ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-apollo && chmod 0440 /etc/sudoers.d/90-apollo
  mkdir -p "$APOLLO_ROOT" "$ENV_DIR" "$APOLLO_ROOT/runner-temp"
  chown apollo:apollo "$APOLLO_ROOT" "$APOLLO_ROOT/runner-temp"
}

phase_node() {
  log "node: Node $NODE_MAJOR from nodejs.org, checksum-verified"
  if command -v node >/dev/null && node -v | grep -q "^v$NODE_MAJOR\."; then echo "already $(node -v)"; return; fi
  local base=https://nodejs.org/dist/latest-v${NODE_MAJOR}.x tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  local file; file="$(grep -o "node-v[0-9.]*-linux-x64.tar.xz" "$tmp/SHASUMS256.txt" | head -1)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  node -v | grep -q "^v$NODE_MAJOR\." && npm -v
}

phase_docker() {
  log 'docker: engine enabled, PostgreSQL+pgvector container on 127.0.0.1:5432'
  systemctl enable --now docker
  docker pull "$PG_IMAGE"
  if ! docker ps -a --format '{{.Names}}' | grep -qx apollo-postgres; then
    # The same service the CI declares: db apollo_v2, user apollo, password apollo-ci (test credentials, not a secret).
    docker run -d --name apollo-postgres --restart unless-stopped \
      -e POSTGRES_DB=apollo_v2 -e POSTGRES_USER=apollo -e POSTGRES_PASSWORD=apollo-ci \
      -p 127.0.0.1:5432:5432 -v apollo-postgres-data:/var/lib/postgresql/data \
      --health-cmd 'pg_isready -U apollo -d apollo_v2' --health-interval 10s --health-timeout 5s --health-retries 10 \
      "$PG_IMAGE"
  else
    docker start apollo-postgres >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' apollo-postgres)" = healthy ] && break; sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' apollo-postgres)" = healthy ] || { echo 'postgres not healthy' >&2; exit 1; }
}

phase_repo() {
  log "repo: $REPO_URL at $REPO_REF"
  local as=(runuser -u apollo --)
  mkdir -p "$APOLLO_ROOT"; chown apollo:apollo "$APOLLO_ROOT"
  if [ ! -d "$REPO_DIR/.git" ]; then "${as[@]}" git clone "$REPO_URL" "$REPO_DIR"; else "${as[@]}" git -C "$REPO_DIR" fetch --prune origin; fi
  "${as[@]}" git -C "$REPO_DIR" checkout --detach "$REPO_REF"
  "${as[@]}" git -C "$REPO_DIR" rev-parse HEAD | tee "$APOLLO_ROOT/REPO_SHA"
  "${as[@]}" touch "$REPO_DIR/.env" # the CI does the same ("Prepare integration environment"); no value in it
}

phase_infra() {
  log 'infra: MinIO image built from the pinned source (infra/object-storage), test credentials as in the CI'
  [ -f "$REPO_DIR/infra/object-storage/compose.yml" ] || phase_repo
  cat > "$ENV_DIR/minio.env" <<'EOF'
MINIO_ROOT_USER=apollo-ci-storage
MINIO_ROOT_PASSWORD=apollo-ci-storage-password
MINIO_API_PORT=59000
MINIO_CONSOLE_PORT=59001
APOLLO_V2_S3_BUCKET=apollo-test-env
EOF
  local attempt
  for attempt in 1 2 3; do
    docker compose -p apollo-minio --env-file "$ENV_DIR/minio.env" -f "$REPO_DIR/infra/object-storage/compose.yml" up -d --build minio && break
    echo "minio build attempt $attempt failed (Go proxy/network is intermittent); retrying" >&2; sleep 20
  done
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' apollo-minio-minio-1 2>/dev/null)" = healthy ] && break; sleep 3
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' apollo-minio-minio-1)" = healthy ] || { echo 'minio not healthy' >&2; exit 1; }
}

phase_deps() {
  log 'deps: runs as the unprivileged user "apollo" (system libraries for Chromium as root first)'
  [ -d "$REPO_DIR/.git" ] || phase_repo
  mkdir -p "$BROWSERS_DIR"; chown -R apollo:apollo "$BROWSERS_DIR"
  chown -R apollo:apollo "$REPO_DIR"
  # Chromium's system libraries need root. The browser itself is installed by the user, below.
  (cd "$REPO_DIR" && [ -d node_modules/playwright-core ] && node node_modules/playwright-core/cli.js install-deps chromium) || true
  runuser -u apollo -- env bash "$0" deps_user
  [ -d "$REPO_DIR/node_modules/playwright-core" ] && (cd "$REPO_DIR" && node node_modules/playwright-core/cli.js install-deps chromium)
  ln -sfn "$(ls -d "$BROWSERS_DIR"/chromium-*/chrome-linux*/chrome | head -1)" /usr/local/bin/playwright-chromium
}

phase_deps_user() {
  log 'deps_user: operations venv, locked dependencies, Prisma client, Remotion bundle, Playwright Chromium, pidfd addon, production build'
  cd "$REPO_DIR"
  [ -x "$OPS_VENV/bin/python" ] || python3 -m venv "$OPS_VENV"
  "$OPS_VENV/bin/python" -m pip install --quiet --only-binary=:all: -r scripts/ops/digitalocean-validation/requirements.txt
  # npm ci runs the repo postinstall, which generates the Prisma clients (slow: minutes). Skipped when the lock did not change.
  lock_sha="$(sha256sum package-lock.json remotion/package-lock.json | sha256sum | cut -d" " -f1)"
  if [ "$(cat node_modules/.apollo-lock-sha 2>/dev/null)" != "$lock_sha" ]; then npm ci; npm ci --prefix remotion; echo "$lock_sha" > node_modules/.apollo-lock-sha; fi
  npm run remotion:build
  # Chromium of the Playwright version in the lock, in a stable path outside the home directory.
  export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"
  npx playwright install chromium
  # The perception pidfd addon the CI builds before the unit tests (refuses uid 0; needs the runner variables).
  export RUNNER_TEMP="$APOLLO_ROOT/runner-temp" GITHUB_ENV="$APOLLO_ROOT/runner-temp/github_env" GITHUB_SHA
  GITHUB_SHA="$(git rev-parse HEAD)"; : > "$GITHUB_ENV"
  bash scripts/validation/build-perception-pidfd.sh
  cat "$GITHUB_ENV"
  npm run build
}

phase_oracle() {
  log 'oracle: OpenVINO/OpenCV/NumPy private package root, OMZ models, runtime manifest'
  [ -d "$REPO_DIR" ] || phase_repo
  # Python 3.12 (the distribution's). The accepted Windows runtime is 3.14; the Linux producer is NOT in the registry (see the runbook).
  [ -x "$ORACLE_VENV/bin/python" ] || python3 -m venv "$ORACLE_VENV"
  if [ ! -d "$ORACLE_PYDEPS/openvino" ]; then
    "$ORACLE_VENV/bin/python" -m pip install --quiet --upgrade pip
    "$ORACLE_VENV/bin/python" -m pip install --only-binary=:all: --no-compile --target "$ORACLE_PYDEPS" \
      "openvino==$OPENVINO_VERSION" "opencv-python-headless==$OPENCV_VERSION.*" "numpy==$NUMPY_VERSION"
  fi
  mkdir -p "$MODEL_DIR"
  for f in face-detection-0204.xml face-detection-0204.bin face-detection-retail-0004.xml face-detection-retail-0004.bin LICENSE; do
    [ -f "$MODEL_DIR/$f" ] || { [ -f "$MODEL_SRC/$f" ] && cp "$MODEL_SRC/$f" "$MODEL_DIR/$f"; } || { echo "missing $f (set APOLLO_MODEL_SOURCE_DIR)" >&2; exit 1; }
  done
  [ "$(sha_of "$MODEL_DIR/face-detection-0204.xml")" = "$SHA_V9_XML" ] && [ "$(sha_of "$MODEL_DIR/face-detection-0204.bin")" = "$SHA_V9_BIN" ] \
    && [ "$(sha_of "$MODEL_DIR/face-detection-retail-0004.xml")" = "$SHA_RETAIL_XML" ] && [ "$(sha_of "$MODEL_DIR/face-detection-retail-0004.bin")" = "$SHA_RETAIL_BIN" ] \
    && [ "$(sha_of "$MODEL_DIR/LICENSE")" = "$SHA_LICENSE" ] || { echo 'model files differ from the pinned SHA-256' >&2; exit 1; }
  chmod a-w "$MODEL_DIR"/*
  # Inventory of the private package root (pin for APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256).
  if [ ! -f "$ENV_DIR/face-runtime-manifest.json" ]; then
    (cd "$REPO_DIR" && node scripts/ops/build-face-runtime-manifest.mjs --root "$ORACLE_PYDEPS" --out "$ENV_DIR/face-runtime-manifest.json" > "$ENV_DIR/face-runtime-manifest.receipt.json")
  fi
}

phase_envfile() {
  log 'envfile: /opt/apollo/env/test-env.sh (no secrets)'
  local py ffmpeg_sha ffprobe_sha
  py="$ORACLE_VENV/bin/python"
  ffmpeg_sha="$(sha_of "$(readlink -f /usr/bin/ffmpeg)")"
  ffprobe_sha="$(sha_of "$(readlink -f /usr/bin/ffprobe)")"
  local manifest_sha; manifest_sha="$(jq -r .manifestSha256 "$ENV_DIR/face-runtime-manifest.receipt.json")"
  local bridge_oracle="$REPO_DIR/src/v2/infrastructure/perception/openvino_pixel_oracle_bridge.py"
  local bridge_face="$REPO_DIR/src/v2/infrastructure/perception/openvino_face0204_bridge.py"
  cat > "$ENV_DIR/test-env.sh" <<EOF
# Generated by provision.sh (phase envfile). NO SECRETS: test credentials only. Source it: . /opt/apollo/env/test-env.sh
export CI=true
export APOLLO_API_ENVIRONMENT=production
export V2_DATABASE_URL='postgresql://apollo:apollo-ci@127.0.0.1:5432/apollo_v2?schema=public'
export PLAYWRIGHT_BROWSERS_PATH='$BROWSERS_DIR'
export PLAYWRIGHT_CHROME_EXECUTABLE=/usr/local/bin/playwright-chromium
# CI: ffprobe is the distribution one; ffmpeg itself stays the pinned ffmpeg-static (approved-final tests compare its binary).
export FFPROBE_PATH=/usr/bin/ffprobe
export PYTHON='$OPS_VENV/bin/python'
export RUNNER_TEMP='$APOLLO_ROOT/runner-temp'
export GITHUB_SHA='$(cat $APOLLO_ROOT/REPO_SHA)'
$(sed 's/^/export /' "$APOLLO_ROOT/runner-temp/github_env" 2>/dev/null)
# MinIO (S3-compatible), test credentials of the CI compose job
export APOLLO_V2_S3_ENDPOINT=http://127.0.0.1:59000
export APOLLO_V2_S3_REGION=us-east-1
export APOLLO_V2_S3_FORCE_PATH_STYLE=true
export APOLLO_V2_S3_ALLOW_INSECURE_HTTP=true
export APOLLO_V2_S3_ACCESS_KEY_ID=apollo-ci-storage
export APOLLO_V2_S3_SECRET_ACCESS_KEY=apollo-ci-storage-password
# W67 MP4 pixel critic (all seven or none)
export APOLLO_V2_PIXEL_ORACLE_PYTHON='$py'
export APOLLO_V2_PIXEL_ORACLE_PYTHON_SHA256=$(sha_of "$py")
export APOLLO_V2_PIXEL_ORACLE_MODULES='$ORACLE_PYDEPS'
export APOLLO_V2_PIXEL_ORACLE_V9_MODEL_DIR='$MODEL_DIR'
export APOLLO_V2_PIXEL_ORACLE_RETAIL_MODEL_DIR='$MODEL_DIR'
export APOLLO_V2_PIXEL_ORACLE_BRIDGE='$bridge_oracle'
export APOLLO_V2_PIXEL_ORACLE_BRIDGE_SHA256=$(sha_of "$bridge_oracle")
# W62 V9 face window worker (refused on linux by the producer registry until a parity receipt exists)
export APOLLO_V2_FACE_V9_PYTHON_BIN='$py'
export APOLLO_V2_FACE_V9_PYTHON_SHA256=$(sha_of "$py")
export APOLLO_V2_FACE_V9_PYTHON_MODULE_DIR='$ORACLE_PYDEPS'
export APOLLO_V2_FACE_V9_RUNTIME_MANIFEST='$ENV_DIR/face-runtime-manifest.json'
export APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256=$manifest_sha
export APOLLO_V2_FACE_V9_MODEL_XML='$MODEL_DIR/face-detection-0204.xml'
export APOLLO_V2_FACE_V9_MODEL_BIN='$MODEL_DIR/face-detection-0204.bin'
export APOLLO_V2_FACE_V9_BRIDGE_SCRIPT='$bridge_face'
export APOLLO_V2_FACE_V9_BRIDGE_SHA256=$(sha_of "$bridge_face")
export APOLLO_V2_FACE_V9_FFMPEG_BIN=/usr/bin/ffmpeg
export APOLLO_V2_FACE_V9_FFMPEG_SHA256=$ffmpeg_sha
export APOLLO_V2_FACE_V9_FFPROBE_BIN=/usr/bin/ffprobe
export APOLLO_V2_FACE_V9_FFPROBE_SHA256=$ffprobe_sha
export APOLLO_V2_FACE_V9_MODEL_LICENSE='$MODEL_DIR/LICENSE'
export APOLLO_V2_FACE_V9_MODEL_LICENSE_SHA256=$SHA_LICENSE
EOF
  chmod 0644 "$ENV_DIR/test-env.sh"
}

main() {
  [ "${1:-}" = deps_user ] || need_root
  local phases=("$@")
  [ "${#phases[@]}" -gt 0 ] || phases=(system node docker repo infra deps oracle envfile)
  for phase in "${phases[@]}"; do "phase_$phase"; done
  log 'done'
}
main "$@"
