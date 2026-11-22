import { randomUUID } from 'node:crypto'
import type { InstallationPlan, SoftwareId, SoftwareReport } from '../shared/model'
import { requiredSoftware } from '../shared/model'
import { harnesses } from '../shared/harnesses'
import { AppError } from './errors'
import { runCommand } from './process'
import { quote } from '../shared/shell'
import { inspectionScript, softwareReport } from '../shared/node/softwareInspection'
import type { CommandResult } from './process'
import type { TargetContext } from './sessions'
import { terminalService } from '../shared/terminalService'
import chatAgents from '../shared/chatAgents.json' with { type: 'json' }

const packages = `install_packages() {
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

/** Editable presets: shown to the user, and run only as submitted. */
function installationScript(id: SoftwareId, socket: string): string {
  if (id === 'outpost-terminal')
    return `#!/bin/sh
set -eu
# Install the matching, immutable Outpost machine service build as the execution user.
${packages}
command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
command -v sha256sum >/dev/null 2>&1 || install_packages coreutils
[ "$(uname -s)" = Linux ] || { echo 'Outpost machine service requires Linux.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Supported Linux architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
libc=glibc
if ldd --version 2>&1 | grep -qi musl; then
  libc=musl
  # Bun's musl executable uses the system C++ runtime (absent on minimal Alpine).
  [ -e /usr/lib/libstdc++.so.6 ] || install_packages libstdc++
fi
asset="outpost-terminal-linux-$arch-$libc"
base=${quote(process.env.OUTPOST_TERMINAL_RELEASE_BASE || `https://github.com/${terminalService.repository}/releases/download/terminal-v${terminalService.version}`)}
umask 077
mkdir -p "$HOME/.outpost/bin"
# Stage on the destination filesystem, then atomically replace the executable.
# Already running sessions keep their original process and in-memory history.
work=$(mktemp -d "$HOME/.outpost/bin/.terminal-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
echo "Downloading Outpost machine service ${terminalService.version} ($arch, $libc)..."
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 "$base/$asset" -o "$work/$asset"
echo 'Downloading checksums...'
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 60 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
echo 'Verifying download...'
(cd "$work" && awk -v asset="$asset" '$2 == asset {print}' SHA256SUMS > selected.sha256 && test -s selected.sha256 && sha256sum -c selected.sha256)
chmod 700 "$work/$asset"
[ "$("$work/$asset" --version)" = 'outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}' ] || { echo 'Unexpected terminal build version.' >&2; exit 1; }
# Reserve this Linux host for its execution account. Never take over an existing reservation.
if [ ! -d /var/lib/outpost-machine ]; then
  if [ "$(id -u)" = 0 ]; then mkdir -m 700 /var/lib/outpost-machine
  else sudo -n sh -c 'mkdir -m 700 /var/lib/outpost-machine && chown "$1" /var/lib/outpost-machine' sh "$(id -u)"; fi
fi
"$work/$asset" pair --managed ${quote(socket)}
mv -f "$work/$asset" "$HOME/.outpost/bin/outpost-terminal"
echo 'Outpost machine service ${terminalService.version} installed.'
`
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
  return `#!/bin/sh
set -eu
# Install ${id} using the target's package manager.
${packages}
install_packages ${id}
echo '${id} installation finished.'
`
}

export interface SoftwareService {
  inspect(context: TargetContext, signal?: AbortSignal): Promise<Omit<SoftwareReport, 'installation'>>
  install(
    context: TargetContext,
    script: string,
    output: (text: string) => void,
    signal: AbortSignal,
  ): Promise<number | null>
}

export class SoftwareClient implements SoftwareService {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  async inspect({ target, transport, machine }: TargetContext, signal?: AbortSignal) {
    const marker = `OUTPOST_SOFTWARE_${randomUUID()}`
    const ids = requiredSoftware(target)
    const result =
      target.kind === 'paired'
        ? await machine.call<CommandResult>(
            'software.inspect',
            { tools: target.tools, marker },
            { signal, timeoutMs: 50000 },
          )
        : await runCommand(transport.management('interactive'), inspectionScript(ids, marker, machine.socket), {
            env: this.env,
            signal,
            timeoutMs: 45_000,
            readOnly: true,
          })
    try {
      return softwareReport(ids, marker, result)
    } catch (error) {
      throw new AppError((error as Error).message, 502)
    }
  }
  async install({ transport }: TargetContext, script: string, onOutput: (text: string) => void, signal: AbortSignal) {
    return (
      await runCommand(transport.management('noninteractive'), script, {
        env: this.env,
        signal,
        onOutput,
        timeoutMs: 15 * 60_000,
      })
    ).code
  }
}

export const planInstallation = (id: SoftwareId, socket: string): InstallationPlan => ({
  softwareId: id,
  script: installationScript(id, socket),
})
