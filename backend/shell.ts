export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const supportingPath = 'export PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"'

// Inspection and installation use the attachment's interactive login environment.
// POSIX sh remains usable before Bash or Python is installed.
export const loginScriptShell = `${supportingPath}
case "\${SHELL##*/}" in
  bash|zsh) if [ -x "$SHELL" ]; then exec "$SHELL" -lic 'exec sh -s'; fi ;;
esac
if command -v bash >/dev/null 2>&1; then exec bash -lic 'exec sh -s'; fi
exec sh -s`
