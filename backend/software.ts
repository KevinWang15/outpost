import { randomUUID } from 'node:crypto'
import type {
  ExecutionEnvironment,
  InstallationPlan,
  SoftwareId,
  SoftwareReport,
  SoftwareStatus,
} from '../shared/model'
import { requiredSoftware } from '../shared/model'
import { harnesses } from '../shared/harnesses'
import { AppError } from './errors'
import { runCommand } from './process'
import { quote, supportingPath } from './shell'
import type { TargetContext } from './sessions'
import { terminalService } from '../shared/terminalService'

const versionFlags: Record<string, string> = { bash: '--version', python3: '--version' }
const minimums: Partial<Record<SoftwareId, { pattern: RegExp; version: [number, number]; label: string }>> = {
  python3: { pattern: /Python (\d+)\.(\d+)/, version: [3, 9], label: 'Python 3.9' },
}

// Read-only, POSIX sh: it must work before Bash or Python are installed.
function inspectionScript(ids: SoftwareId[], marker: string, root: boolean) {
  return `set -eu
${supportingPath}
${root ? '[ "$(id -u)" = 0 ] || { echo "Root SSH access is required." >&2; exit 1; }' : ''}
[ "$(uname -s)" = Linux ] || { echo "Outpost targets must run Linux." >&2; exit 1; }
shell="\${SHELL:-/bin/bash}"
case "\${shell##*/}" in bash|zsh) ;; *) shell=$(command -v bash || printf /bin/bash) ;; esac
printf '\\000%s\\000%s\\000%s\\000%s\\000%s\\000' ${quote(marker)} "$HOME" "$(id -u)" "$(id -un)" "$shell"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
probe() {
  tool=$1
  flag=$2
  path=$(command -v "$tool" || true)
  if [ "$tool" = outpost-terminal ]; then
    path="$HOME/.outpost/bin/outpost-terminal"
    [ -x "$path" ] || path=''
  fi
  if [ -z "$path" ]; then
    printf '%s\\000\\000127\\000\\000' "$tool"
    return
  fi
  # Bound version probes, including a broken executable that waits for input.
  rm -f "$work/finished"
  (ulimit -f 32; exec "$path" "$flag") >"$work/output" 2>&1 < /dev/null &
  pid=$!
  (
    sleeper=''
    trap '[ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null; exit 0' TERM
    [ ! -f "$work/finished" ] || exit 0
    sleep 4 & sleeper=$!
    wait "$sleeper"
    [ ! -f "$work/finished" ] || exit 0
    : >"$work/timedout"
    kill -KILL "$pid" 2>/dev/null || true
  ) >/dev/null 2>&1 < /dev/null &
  watchdog=$!
  code=0
  wait "$pid" || code=$?
  : >"$work/finished"
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  output=$(head -c 4096 "$work/output" | tr -d '\\000')
  if [ -f "$work/timedout" ]; then code=124; output='Version check timed out after 4 seconds'; rm "$work/timedout"; fi
  printf '%s\\000%s\\000%s\\000%s\\000' "$tool" "$path" "$code" "$output"
}
${ids.map(id => `probe ${quote(id)} ${quote(versionFlags[id] ?? '--version')}`).join('\n')}
printf 'END\\000'
`
}

function status(id: SoftwareId, path: string, code: number, output: string): SoftwareStatus {
  if (!path)
    return {
      id,
      status: 'missing',
      path: null,
      version: null,
      detail:
        id === 'outpost-terminal' ? 'Not installed in ~/.outpost/bin.' : 'Not found on the interactive login PATH.',
    }
  const version =
    output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ?? null
  let detail =
    code !== 0
      ? output.trim() || `Version check exited with status ${code}.`
      : !version
        ? 'The version command returned no version.'
        : null
  const minimum = minimums[id]
  if (
    !detail &&
    id === 'outpost-terminal' &&
    version !== `outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`
  )
    detail = `Outpost Terminal ${terminalService.version} is required. Install the matching version.`
  if (!detail && minimum) {
    const match = version!.match(minimum.pattern)
    const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0]
    if (major < minimum.version[0] || (major === minimum.version[0] && minor < minimum.version[1]))
      detail = `${minimum.label} or newer is required.`
  }
  return { id, status: detail ? 'broken' : 'installed', path, version, detail }
}

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
export function installationScript(id: SoftwareId): string {
  if (id === 'outpost-terminal')
    return `#!/bin/sh
set -eu
# Install the matching, immutable Outpost Terminal build as the execution user.
${packages}
command -v curl >/dev/null 2>&1 || install_packages curl ca-certificates
command -v sha256sum >/dev/null 2>&1 || install_packages coreutils
[ "$(uname -s)" = Linux ] || { echo 'Outpost Terminal requires Linux.' >&2; exit 1; }
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
base='https://github.com/${terminalService.repository}/releases/download/terminal-v${terminalService.version}'
umask 077
mkdir -p "$HOME/.outpost/bin"
# Stage on the destination filesystem, then atomically replace the executable.
# Already running sessions keep their original process and in-memory history.
work=$(mktemp -d "$HOME/.outpost/bin/.terminal-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
echo "Downloading Outpost Terminal ${terminalService.version} ($arch, $libc)..."
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 "$base/$asset" -o "$work/$asset"
echo 'Downloading checksums...'
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 60 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
echo 'Verifying download...'
(cd "$work" && awk -v asset="$asset" '$2 == asset {print}' SHA256SUMS > selected.sha256 && test -s selected.sha256 && sha256sum -c selected.sha256)
chmod 700 "$work/$asset"
[ "$("$work/$asset" --version)" = 'outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}' ] || { echo 'Unexpected terminal build version.' >&2; exit 1; }
mv -f "$work/$asset" "$HOME/.outpost/bin/outpost-terminal"
echo 'Outpost Terminal ${terminalService.version} installed.'
`
  const harness = harnesses.find(harness => harness.id === id)
  if (harness)
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
  async inspect({ target, transport }: TargetContext, signal?: AbortSignal) {
    const marker = `OUTPOST_SOFTWARE_${randomUUID()}`
    const ids = requiredSoftware(target)
    const { code, stdout, stderr } = await runCommand(
      transport.management('interactive'),
      inspectionScript(ids, marker, target.kind === 'ssh'),
      { env: this.env, signal, timeoutMs: 45_000 },
    )
    const start = stdout.indexOf(`\0${marker}\0`)
    if (code !== 0 || start < 0)
      throw new AppError(`Software check failed. ${stderr.trim() || 'Check access to the target.'}`, 502)
    const fields = stdout.slice(start + marker.length + 2).split('\0')
    const [home, uid, username, shell] = fields.splice(0, 4)
    const environment: ExecutionEnvironment = { home, uid: Number(uid), username, shell }
    const software: SoftwareStatus[] = []
    for (let index = 0; index < ids.length; index++) {
      const [id, path, exit, output] = fields.splice(0, 4)
      if (
        [id, path, exit, output].some(value => typeof value !== 'string') ||
        !ids.includes(id as SoftwareId) ||
        software.some(item => item.id === id) ||
        !/^\d+$/.test(exit)
      )
        throw new AppError('Invalid software check response', 502)
      software.push(status(id as SoftwareId, path, Number(exit), output))
    }
    if (fields[0] !== 'END' || !home?.startsWith('/') || !/^\d+$/.test(uid) || !username || !shell?.startsWith('/'))
      throw new AppError('Invalid execution environment response', 502)
    return {
      environment,
      checkedAt: new Date().toISOString(),
      software: ids.map(id => software.find(item => item.id === id)!),
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

export const planInstallation = (id: SoftwareId): InstallationPlan => ({
  softwareId: id,
  script: installationScript(id),
})
