import { quote, supportingPath } from '../shell'
import { harnesses } from '../harnesses'
import type { SoftwareId } from '../model'

const versionFlags: Record<string, string> = { bash: '--version' }

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
  flag=$3
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
  set -- "$flag"
  ${managedSocket ? `if [ "$tool" = outpost-terminal ]; then set -- "$flag" --managed ${quote(managedSocket)}; fi` : ''}
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
${ids.map(id => `probe ${quote(id)} ${quote(harnesses.find(h => h.id === id)?.command ?? id)} ${quote(versionFlags[id] ?? '--version')}`).join('\n')}
printf 'END\\000'
`
}
