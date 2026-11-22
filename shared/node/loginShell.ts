import { quote, supportingPath } from '../shell'
export type LoginMode = 'interactive' | 'noninteractive'

// Inspection needs the attachment's interactive PATH. Installers are batch jobs:
// load login profiles without interactive job control on their pipe-only transport.
// POSIX sh remains usable before Bash is installed.
export function loginShell(mode: LoginMode, command = 'exec sh -s') {
  const flags = mode === 'interactive' ? '-lic' : '-lc'
  const run = quote(supportingPath + '\n' + command)
  return `case "\${SHELL##*/}" in
  bash|zsh) if [ -x "$SHELL" ]; then exec "$SHELL" ${flags} ${run}; fi ;;
esac
if command -v bash >/dev/null 2>&1; then exec bash ${flags} ${run}; fi
exec sh -c ${run}`
}
