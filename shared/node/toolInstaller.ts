import type { SoftwareId } from '../model'
import { harnesses } from '../harnesses'
import chatAgents from '../chatAgents.json' with { type: 'json' }

export const packages = `install_packages() {
  elevate=''
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 && sudo -n true || { echo 'Package installation requires passwordless sudo. Install the package as an administrator and retry.' >&2; exit 1; }
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
    echo 'No supported package manager found. Install the package as an administrator and retry.' >&2
    exit 1
  fi
}`

export function toolInstaller(id: SoftwareId): string {
  if (id === 'claude-agent-acp')
    return `#!/bin/sh
set -eu
# Install the official Claude Code ACP adapter ${chatAgents.claude.version} (${chatAgents.claude.license}) for Outpost Chat.
# Outpost runs it with this machine's own claude, so its bundled copy is removed.
${packages}
command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
command -v tar >/dev/null 2>&1 || install_packages tar
[ "$(uname -s)" = Linux ] || { echo 'The adapter requires Linux.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Supported Linux architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
suffix=''
if ldd --version 2>&1 | grep -qi musl; then
  suffix=-musl
  [ -e /usr/lib/libstdc++.so.6 ] || install_packages libstdc++ libgcc
fi
version='${chatAgents.claude.version}'
asset="claude-agent-acp-linux-$arch$suffix.tar.gz"
umask 077
mkdir -p "$HOME/.outpost/bin" "$HOME/.outpost/agents"
work=$(mktemp -d "$HOME/.outpost/agents/.install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
echo "Downloading the Claude Code ACP adapter $version ($arch$suffix, about 200 MB)..."
curl --proto '=https' --tlsv1.2 -fSL --connect-timeout 15 --max-time 900 \
  "https://github.com/${chatAgents.claude.repository}/releases/download/v$version/$asset" -o "$work/$asset"
mkdir "$work/unpacked"
tar -xzf "$work/$asset" -C "$work/unpacked"
rm -f "$work/$asset" "$work/unpacked/claude"
chmod 700 "$work/unpacked/claude-agent-acp"
[ "$("$work/unpacked/claude-agent-acp" --version)" = "$version" ] || { echo 'Unexpected adapter version.' >&2; exit 1; }
rm -rf "$HOME/.outpost/agents/claude-agent-acp-$version"
mv "$work/unpacked" "$HOME/.outpost/agents/claude-agent-acp-$version"
ln -sfn "../agents/claude-agent-acp-$version/claude-agent-acp" "$HOME/.outpost/bin/.claude-agent-acp.new"
mv -f "$HOME/.outpost/bin/.claude-agent-acp.new" "$HOME/.outpost/bin/claude-agent-acp"
echo "Claude Code ACP adapter $version installed."
`
  const harness = harnesses.find(harness => harness.id === id)
  if (harness && 'npm' in harness.installer)
    return `#!/bin/sh
set -eu
# Install the official DeepSeek Harness CLI as the execution user.
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { echo 'Install Node.js 24.9 or newer and npm first.' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<24||(major===24&&minor<9))process.exit(1)' || { echo 'Node.js 24.9 or newer is required.' >&2; exit 1; }
npm install --global --prefix "$HOME/.local" '${harness.installer.npm}'
echo '${harness.label} installed. Configure its DeepSeek credentials before opening a chat.'
`
  if (harness && 'url' in harness.installer)
    return `#!/bin/sh
set -eu
# Install ${harness.label} using its official installer, as the execution user.
${packages}
command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
${harness.installer.shell === 'bash' ? 'command -v bash >/dev/null 2>&1 || install_packages bash\n' : ''}work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 15 --max-time 120 '${harness.installer.url}' -o "$work/install.sh"
${harness.installer.shell} "$work/install.sh"
echo '${harness.label} installer finished.'
`
  if (id !== 'bash') throw new Error('Unknown software requirement.')
  return `#!/bin/sh
set -eu
# Install ${id} using the target's package manager.
${packages}
install_packages ${id}
echo '${id} installation finished.'
`
}
