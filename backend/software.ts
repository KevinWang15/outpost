import { randomUUID } from 'node:crypto'
import type {
  ExecutionEnvironment,
  InstallationPlan,
  SoftwareId,
  SoftwareReport,
  SoftwareStatus,
  Target,
} from '../shared/session-manager'
import { requiredSoftware } from '../shared/session-manager'
import { AppError } from './errors'
import { runCommand } from './process'
import { quote, supportingPath } from './shell'
import { transportFor } from './transport'
import { installationScript } from './software-scripts'

const versionFlags: Record<SoftwareId, string> = {
  bash: '--version',
  python3: '--version',
  tmux: '-V',
  dtach: '--help',
  lsof: '-v',
  codex: '--version',
  kimi: '--version',
  claude: '--version',
}

function inspectionScript(target: Target, marker: string) {
  const ids: SoftwareId[] = ['bash', 'python3', ...target.backends, ...target.tools]
  return `set -eu
${supportingPath}
${transportFor(target).rootRequired ? '[ "$(id -u)" = 0 ] || { echo "Root SSH access is required." >&2; exit 1; }' : ''}
platform=$(uname -s)
case "$platform" in Linux|Darwin) ;; *) echo "Only Linux and macOS execution hosts are supported." >&2; exit 1 ;; esac
shell="\${SHELL:-/bin/bash}"
case "\${shell##*/}" in bash|zsh) ;; *) shell=$(command -v bash || printf /bin/bash) ;; esac
printf '\\000%s\\000%s\\000%s\\000%s\\000%s\\000%s\\000' ${quote(marker)} "$HOME" "$(id -u)" "$(id -un)" "$platform" "$shell"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
probe() {
  tool=$1
  flag=$2
  path=$(command -v "$tool" || true)
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
    # The probe may finish before this subshell can handle cancellation.
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
${ids.map((id) => `probe ${quote(id)} ${quote(versionFlags[id])}`).join('\n')}
${target.backends.includes('dtach') ? 'if [ "$platform" = Darwin ]; then probe lsof -v; fi' : ''}
printf 'END\\000'
`
}
function status(
  id: SoftwareId,
  path: string,
  code: number,
  output: string,
): SoftwareStatus {
  if (!path)
    return {
      id,
      status: 'missing',
      path: null,
      version: null,
      detail: 'Not found on the interactive login PATH.',
    }
  let version =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  if (id === 'lsof')
    version =
      output
        .match(/(?:^|\n)\s*(?:revision|version):\s*([^\n]+)/i)?.[1]
        ?.trim() ?? version
  let detail =
    code !== 0
      ? output.trim() || `Version check exited with status ${code}.`
      : !version
        ? 'The version command returned no version.'
        : null
  if (!detail && id === 'python3') {
    const match = version!.match(/Python (\d+)\.(\d+)/)
    if (
      !match ||
      Number(match[1]) < 3 ||
      (Number(match[1]) === 3 && Number(match[2]) < 9)
    )
      detail = 'Python 3.9 or newer is required.'
  }
  if (!detail && id === 'dtach') {
    const match = version!.match(/version (\d+)\.(\d+)/)
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 9))
      detail = 'dtach 0.9 or newer is required.'
  }
  return { id, status: detail ? 'broken' : 'installed', path, version, detail }
}
export interface SoftwareService {
  inspect(
    target: Target,
    signal?: AbortSignal,
  ): Promise<Omit<SoftwareReport, 'installation'>>
  plan(
    target: Target,
    id: SoftwareId,
    signal?: AbortSignal,
  ): Promise<InstallationPlan>
  install(
    target: Target,
    script: string,
    output: (text: string) => void,
    signal: AbortSignal,
  ): Promise<number | null>
}
export class SoftwareClient implements SoftwareService {
  constructor(private env = process.env, private requireAccountIdentity = false) {}
  async inspect(
    target: Target,
    signal?: AbortSignal,
  ): Promise<Omit<SoftwareReport, 'installation'>> {
    const marker = `OUTPOST_SOFTWARE_${randomUUID()}`
    const { code, stdout, stderr } = await runCommand(
      transportFor(target, this.requireAccountIdentity).script(),
      inspectionScript(target, marker),
      { env: this.env, signal, timeoutMs: 45_000 },
    )
    const start = stdout.indexOf(`\0${marker}\0`)
    if (code !== 0 || start < 0)
      throw new AppError(
        `Software check failed. ${stderr.trim() || 'Check access to the execution host.'}`,
        502,
      )
    const fields = stdout.slice(start + marker.length + 2).split('\0')
    const [home, uid, username, platform, shell] = fields.splice(0, 5)
    const environment: ExecutionEnvironment = {
      home,
      uid: Number(uid),
      username,
      platform: platform === 'Darwin' ? 'darwin' : 'linux',
      shell,
    }
    const ids = requiredSoftware(target, environment.platform)
    const software: SoftwareStatus[] = []
    for (let index = 0; index < ids.length; index++) {
      const [id, path, exit, output] = fields.splice(0, 4)
      if (
        [id, path, exit, output].some((value) => typeof value !== 'string') ||
        !ids.includes(id as SoftwareId) ||
        software.some((item) => item.id === id) ||
        !/^\d+$/.test(exit)
      )
        throw new AppError('Invalid software check response', 502)
      software.push(status(id as SoftwareId, path, Number(exit), output))
    }
    if (
      fields[0] !== 'END' ||
      !home?.startsWith('/') ||
      !/^\d+$/.test(uid) ||
      !username ||
      !shell?.startsWith('/') ||
      !['Darwin', 'Linux'].includes(platform)
    )
      throw new AppError('Invalid execution environment response', 502)
    if (
      target.environment &&
      (target.environment.home !== home ||
        target.environment.uid !== environment.uid ||
        target.environment.username !== username)
    )
      throw new AppError(
        'The execution user or home changed. Add a new target for this account.',
        409,
      )
    return {
      environment,
      checkedAt: new Date().toISOString(),
      software: ids.map((id) => software.find((item) => item.id === id)!),
    }
  }
  async plan(target: Target, id: SoftwareId, signal?: AbortSignal) {
    const report = await this.inspect(target, signal)
    if (!report.software.some((item) => item.id === id))
      throw new AppError('Software is not required by this target', 400)
    return { softwareId: id, script: installationScript(id) }
  }
  async install(
    target: Target,
    script: string,
    onOutput: (text: string) => void,
    signal: AbortSignal,
  ) {
    return (
      await runCommand(transportFor(target, this.requireAccountIdentity).script(), script, {
        env: this.env,
        signal,
        onOutput,
        timeoutMs: 15 * 60_000,
      })
    ).code
  }
}
