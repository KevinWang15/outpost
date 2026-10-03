import type { SoftwareId } from '../shared/session-manager'

// Upstream installer sources are linked in README; scripts stay visible/editable.
const installers = {
  codex: { url: 'https://chatgpt.com/codex/install.sh', shell: 'sh' },
  kimi: { url: 'https://code.kimi.com/kimi-code/install.sh', shell: 'bash' },
  claude: { url: 'https://claude.ai/install.sh', shell: 'bash' },
}
const packages = `install_packages() {
  if [ "$(uname -s)" = Darwin ]; then
    command -v brew >/dev/null 2>&1 || { echo 'Install Homebrew first, or edit this script for your package manager.' >&2; exit 1; }
    for package in "$@"; do
      [ "$package" != python3 ] || package=python
      [ "$package" != ca-certificates ] || continue
      if brew list --versions "$package" >/dev/null 2>&1; then brew reinstall "$package"; else brew install "$package"; fi
    done
    return
  fi
  elevate=''
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 && sudo -n true || { echo 'Package installation requires passwordless sudo. Edit the script or install manually.' >&2; exit 1; }
    elevate='sudo -n'
  fi
  if command -v apt-get >/dev/null 2>&1; then
    $elevate apt-get update
    $elevate env DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall "$@"
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
export function installationScript(id: SoftwareId): string {
  if (id === 'codex' || id === 'kimi' || id === 'claude') {
    const installer = installers[id]
    return `#!/bin/sh
set -eu
# Install ${id} using its official installer, as the execution user.
${packages}
command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
${installer.shell === 'bash' ? 'command -v bash >/dev/null 2>&1 || install_packages bash\n' : ''}work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 15 --max-time 120 '${installer.url}' -o "$work/install.sh"
${installer.shell} "$work/install.sh"
echo '${id} installer finished. Refresh Required Software to verify the installation.'
`
  }
  return `#!/bin/sh
set -eu
# Install ${id} using the execution host's package manager.
${packages}
install_packages ${id}
echo '${id} installation finished.'
`
}
