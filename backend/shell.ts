import { supportingPath } from '../shared/shell'
export type LoginMode = 'interactive' | 'noninteractive'

// Inspection needs the attachment's interactive PATH. Installers are batch jobs:
// load login profiles without interactive job control on their pipe-only transport.
// POSIX sh remains usable before Bash is installed.
export function loginScriptShell(mode: LoginMode) {
  const flags = mode === 'interactive' ? '-lic' : '-lc'
  return `${supportingPath}
case "\${SHELL##*/}" in
  bash|zsh) if [ -x "$SHELL" ]; then exec "$SHELL" ${flags} 'exec sh -s'; fi ;;
esac
if command -v bash >/dev/null 2>&1; then exec bash ${flags} 'exec sh -s'; fi
exec sh -s`
}
