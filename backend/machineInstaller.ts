import { quote } from '../shared/shell'
import { terminalService } from '../shared/terminalService'

export const packages = `install_packages() {
  elevate=''
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 && sudo -n true || { echo 'Package installation requires passwordless sudo. Edit the script or install manually.' >&2; exit 1; }
    elevate='sudo -n'
  fi
  if command -v apt-get >/dev/null 2>&1; then
    $elevate apt-get update
    $elevate env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    $elevate dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    $elevate yum install -y "$@"
  elif command -v apk >/dev/null 2>&1; then
    $elevate apk add --no-cache "$@"
  elif command -v pacman >/dev/null 2>&1; then
    $elevate pacman -S --noconfirm --needed "$@"
  else
    echo 'No supported package manager found. Edit this script to install the software manually.' >&2
    exit 1
  fi
}`

export const machineReleaseBase = () =>
  process.env.OUTPOST_TERMINAL_RELEASE_BASE ||
  `https://github.com/${terminalService.repository}/releases/download/terminal-v${terminalService.version}`

/** A socket selects the server-managed installation. The public script accepts relay or direct enrollment. */
export function machineInstaller(socket?: string) {
  return `#!/bin/sh
set -eu
# Install the matching, immutable Outpost machine service build as the execution user.
install_machine() {
${
  socket === undefined
    ? `case "\${1:-}" in
  relay) [ "$#" -eq 2 ] && [ -n "$2" ] || { echo 'Expected relay SERVER.' >&2; exit 1; }; pair_arg=$2 ;;
  direct) [ "$#" -eq 1 ] || exit 1; pair_arg=--direct ;;
  *) echo 'Use the installation command from your Outpost machine page.' >&2; exit 1 ;;
esac
enrollment=\${OUTPOST_ENROLLMENT:?Missing Outpost enrollment data}
unset OUTPOST_ENROLLMENT
asset_dir=\${OUTPOST_ASSET_DIR:-}
[ -z "$asset_dir" ] || [ "$1" = direct ] || { echo 'Offline installation requires Direct only.' >&2; exit 1; }`
    : 'asset_dir='
}
${packages}
[ "$(uname -s)" = Linux ] || { echo 'Outpost machine service requires Linux.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Supported Linux architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
if [ -n "$asset_dir" ]; then
  command -v sha256sum >/dev/null || { echo 'Install sha256sum before offline installation.' >&2; exit 1; }
else
  command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
  command -v sha256sum >/dev/null 2>&1 || install_packages coreutils
fi
libc=glibc
if ldd --version 2>&1 | grep -qi musl; then
  libc=musl
  # Bun's musl executable uses the system C++ runtime (absent on minimal Alpine).
  if [ ! -e /usr/lib/libstdc++.so.6 ]; then
    [ -z "$asset_dir" ] || { echo 'Install libstdc++ before offline installation.' >&2; exit 1; }
    install_packages libstdc++
  fi
fi
asset="outpost-terminal-linux-$arch-$libc"
base=${quote(machineReleaseBase())}
umask 077
mkdir -p "$HOME/.outpost/bin"
# Stage on the destination filesystem, then atomically replace the executable.
# Already running sessions keep their original process and in-memory history.
work=$(mktemp -d "$HOME/.outpost/bin/.terminal-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
if [ -n "$asset_dir" ]; then
  cp "$asset_dir/$asset" "$asset_dir/SHA256SUMS" "$work/"
else
  echo "Downloading Outpost machine service ${terminalService.version} ($arch, $libc)..."
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 "$base/$asset" -o "$work/$asset"
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 60 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
fi
echo 'Verifying download...'
(cd "$work" && awk -v asset="$asset" '$2 == asset {print}' SHA256SUMS > selected.sha256 && test -s selected.sha256 && sha256sum -c selected.sha256)
chmod 700 "$work/$asset"
[ "$("$work/$asset" --version)" = 'outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}' ] || { echo 'Unexpected terminal build version.' >&2; exit 1; }
# Reserve this Linux host for its execution account. Never take over an existing reservation.
if [ ! -d /var/lib/outpost-machine ]; then
  if [ "$(id -u)" = 0 ]; then mkdir -m 700 /var/lib/outpost-machine
  else ${socket === undefined ? 'sudo' : 'sudo -n'} sh -c 'mkdir -m 700 /var/lib/outpost-machine && chown "$1" /var/lib/outpost-machine' sh "$(id -u)"; fi
fi
${
  socket === undefined
    ? `printf '%s\\n' "$enrollment" | "$work/$asset" pair "$pair_arg"
unset enrollment`
    : `"$work/$asset" pair --managed ${quote(socket)}`
}
mv -f "$work/$asset" "$HOME/.outpost/bin/outpost-terminal"
echo 'Outpost machine service ${terminalService.version} installed.'
${
  socket === undefined
    ? `rm -rf "$work"
trap - EXIT HUP INT TERM
echo 'Starting the connector in this terminal. To start it again, run ~/.outpost/bin/outpost-terminal connect.'
exec "$HOME/.outpost/bin/outpost-terminal" connect </dev/null`
    : ''
}
}
install_machine "$@"
`
}
