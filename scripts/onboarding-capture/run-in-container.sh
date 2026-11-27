#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-all}"
OUT_DIR="/output"
mkdir -p "$OUT_DIR"

# Sync source into an isolated container workdir so host node_modules and desktop/target
# (e.g. Windows/macOS host artifacts) are never overwritten or conflicted.
mkdir -p /work
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'desktop/node_modules' \
  --exclude 'desktop/target' \
  --exclude 'desktop/dist' \
  --exclude 'desktop/release' \
  --exclude 'machine/test-dist' \
  --exclude 'machine/dist' \
  /repo/ /work/

cd /work

# Ensure Python fixture shebangs have LF endings when mounted from Windows hosts.
sed -i 's/\r$//' tests/fixtures/*.py

# Reuse persistent Docker cache volumes for fast repeat captures.
mkdir -p /cache/cargo /cache/target /cache/machine_test_dist /tmp/xdg-runtime
chmod 700 /tmp/xdg-runtime
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
export CARGO_HOME=/cache/cargo
export CARGO_TARGET_DIR=/cache/target

# Point Vulkan to Mesa's software Lavapipe ICD so GPUI's WgpuHeadlessRenderer works on any CPU.
LVP_ICD="$(ls /usr/share/vulkan/icd.d/lvp_icd.*.json 2>/dev/null | head -n 1 || true)"
if [[ -n "$LVP_ICD" ]]; then
  export VK_ICD_FILENAMES="$LVP_ICD"
  export VK_DRIVER_FILES="$LVP_ICD"
fi
export OUTPOST_ONBOARDING_SCREENSHOTS="$OUT_DIR"

if [[ "$MODE" == "all" || "$MODE" == "web" ]]; then
  echo "==> Preparing Linux node_modules cache..."
  LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
  if [[ ! -d /work/node_modules/@playwright/test || ! -f /work/node_modules/.lock-hash || "$(cat /work/node_modules/.lock-hash)" != "$LOCK_HASH" ]]; then
    npm ci --no-audit --no-fund
    printf '%s' "$LOCK_HASH" > /work/node_modules/.lock-hash
  fi

  echo "==> Preparing fixture outpost-terminal binary..."
  ln -sfn /cache/machine_test_dist /work/machine/test-dist
  ARCH="$(node -p 'process.arch')"
  FIXTURE_BIN="/work/machine/test-dist/outpost-terminal-linux-${ARCH}-glibc"
  MACHINE_HASH="$(find machine shared scripts/build-terminal.mjs scripts/vendor-agents.mjs -type f | sort | xargs sha256sum | sha256sum | awk '{print $1}')"
  if [[ ! -x "$FIXTURE_BIN" || ! -f /cache/machine_test_dist/.machine-hash || "$(cat /cache/machine_test_dist/.machine-hash)" != "$MACHINE_HASH" ]]; then
    npm exec --yes --package=bun@1.4.3 -- node scripts/build-terminal.mjs --fixtures
    printf '%s' "$MACHINE_HASH" > /cache/machine_test_dist/.machine-hash
  fi

  echo "==> Capturing Web UI onboarding screenshots inside Xvfb..."
  xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/onboarding-capture/capture-web.mjs
fi

if [[ "$MODE" == "all" || "$MODE" == "desktop" ]]; then
  echo "==> Capturing Outpost Desktop (GPUI) onboarding screenshots inside Xvfb + Lavapipe..."
  xvfb-run -a -s "-screen 0 1600x1000x24" \
    cargo test --manifest-path desktop/Cargo.toml --locked --features ui-tests --test onboarding_screenshots
fi

echo "==> Generated onboarding screenshots in docs/onboarding/:"
ls -lh "$OUT_DIR"/*.png
