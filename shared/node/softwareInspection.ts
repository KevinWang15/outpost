import { quote, supportingPath } from '../shell'
import { harnesses } from '../harnesses'
import type { ExecutionEnvironment, SoftwareId, SoftwareStatus } from '../model'
import { terminalService } from '../terminalService'
import chatAgents from '../chatAgents.json' with { type: 'json' }
import type { CommandResult } from '../../backend/process'

// Read-only, POSIX sh: it must work before Bash is installed.
export function inspectionScript(ids: SoftwareId[], marker: string, managedSocket?: string) {
  return `set -eu
${supportingPath}
[ "$(uname -s)" = Linux ] || { echo "Outpost machines must run Linux." >&2; exit 1; }
shell="\${SHELL:-/bin/bash}"
case "\${shell##*/}" in bash|zsh) ;; *) shell=$(command -v bash || printf /bin/bash) ;; esac
printf '\\000%s\\000%s\\000%s\\000%s\\000%s\\000' ${quote(marker)} "$HOME" "$(id -u)" "$(id -un)" "$shell"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
probe() {
  tool=$1
  command=$2
  path=$(command -v "$command" || true)
  if [ "$tool" = outpost-terminal ] || [ "$tool" = claude-agent-acp ]; then
    path="$HOME/.outpost/bin/$tool"
    [ -x "$path" ] || path=''
  fi
  if [ -z "$path" ]; then
    printf '%s\\000\\000127\\000\\000' "$tool"
    return
  fi
  # Bound version probes, including a broken executable that waits for input.
  rm -f "$work/finished"
  set -- --version
  ${managedSocket ? `if [ "$tool" = outpost-terminal ]; then set -- "$@" --socket ${quote(managedSocket)}; fi` : ''}
  (ulimit -f 32; exec "$path" "$@") >"$work/output" 2>&1 < /dev/null &
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
${ids.map(id => `probe ${quote(id)} ${quote(harnesses.find(h => h.id === id)?.command ?? id)}`).join('\n')}
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
        id === 'outpost-terminal'
          ? 'Not installed in ~/.outpost/bin.'
          : id === 'claude-agent-acp'
            ? 'Needed for Claude Code sessions in chat. Not installed in ~/.outpost/bin.'
            : 'Not found on the interactive login PATH.',
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
  if (
    !detail &&
    id === 'outpost-terminal' &&
    version !== `outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`
  )
    detail = `Outpost machine service ${terminalService.version} is required. Install the matching version.`
  if (!detail && id === 'claude-agent-acp' && version !== chatAgents.claude.version)
    detail = `The Claude Code chat adapter ${chatAgents.claude.version} is required. Install the matching version.`
  return { id, status: detail ? 'broken' : 'installed', path, version, detail }
}

export function softwareReport(ids: SoftwareId[], marker: string, { code, stdout, stderr }: CommandResult) {
  const start = stdout.indexOf(`\0${marker}\0`)
  if (code !== 0 || start < 0)
    throw new Error(`Software check failed. ${stderr.trim() || 'Check access to the machine.'}`)
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
      throw new Error('Invalid software check response')
    software.push(status(id as SoftwareId, path, Number(exit), output))
  }
  if (fields[0] !== 'END' || !home?.startsWith('/') || !/^\d+$/.test(uid) || !username || !shell?.startsWith('/'))
    throw new Error('Invalid execution environment response')
  return {
    environment,
    checkedAt: new Date().toISOString(),
    software: ids.map(id => software.find(item => item.id === id)!),
  }
}
