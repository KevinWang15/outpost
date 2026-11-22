import { quote } from '../shared/shell'
import { terminalService } from '../shared/terminalService'

export const detectPlatform = `[ "$(uname -s)" = Linux ] || { echo 'Outpost machines require Linux.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Unsupported machine architecture.' >&2; exit 1 ;;
esac
libc=glibc
if ldd --version 2>&1 | grep -qi musl; then libc=musl; fi
platform="$arch-$libc"`

const asRoot = 'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }'

const prepare = `umask 077
mkdir -p "$HOME/.outpost/bin"
work=$(mktemp -d "$HOME/.outpost/bin/.setup.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
if [ ! -d /var/lib/outpost-machine ]; then
  as_root sh -c 'mkdir -m 700 /var/lib/outpost-machine && chown "$1" /var/lib/outpost-machine' sh "$(id -u)" ||
    { echo 'Ask an administrator to provision /var/lib/outpost-machine with mode 700 for this execution account.' >&2; exit 1; }
fi`

const verify = `(cd "$work" && printf '%s  machine\\n' "$checksum" | sha256sum -c -)
chmod 700 "$work/machine"
[ "$("$work/machine" --version)" = 'outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}' ] ||
  { echo 'Unexpected machine service build. Check system libraries and the release.' >&2; exit 1; }`

export function sshServiceInstaller(socket: string, sha256: string) {
  return `set -eu
${asRoot}
${prepare}
cat > "$work/machine"
checksum=${quote(sha256)}
${verify}
"$work/machine" enroll ssh ${quote(socket)}
mv -f "$work/machine" "$HOME/.outpost/bin/outpost-terminal"`
}

export function sshToolInstaller(sha256: string) {
  return `set -eu
umask 077
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
cd "$work"
cat > tool.tar.gz
printf '%s  tool.tar.gz\\n' ${quote(sha256)} | sha256sum -c -
mkdir tool
tar -xzf tool.tar.gz -C tool
cd tool
sh ./install.sh`
}

/** The operator explicitly installs one visible, boot-managed outbound service. */
export function machineInstaller() {
  return `#!/bin/sh
set -eu
[ "$#" -eq 2 ] || { echo 'Use the install command from the machine page.' >&2; exit 1; }
origin=$1
target=$2
enrollment=\${OUTPOST_ENROLLMENT:?Missing enrollment code}
unset OUTPOST_ENROLLMENT
case "$origin" in https://*|http://127.0.0.1:*|http://localhost:*|http://\\[::1\\]:*) ;; *) echo 'Use the HTTPS address of your Outpost server.' >&2; exit 1 ;; esac
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then manager=systemd
elif command -v rc-update >/dev/null && command -v supervise-daemon >/dev/null; then manager=openrc
else echo 'Outbound setup requires systemd or OpenRC to start at boot. Connect over SSH on other machines.' >&2; exit 1; fi
${asRoot}
as_root true || { echo 'An administrator must authorize service installation. Run sudo -v in this shell, then retry.' >&2; exit 1; }
${detectPlatform}
${prepare}
base="$origin/api/install/$platform"
curl -fsS --connect-timeout 15 --max-time 300 "$base/binary" -o "$work/machine"
checksum=$(curl -fsS --connect-timeout 15 --max-time 60 "$base/sha256")
${verify}
printf '%s\\n' "$enrollment" | "$work/machine" enroll outbound "$origin" "$target"
unset enrollment
mv -f "$work/machine" "$HOME/.outpost/bin/outpost-terminal"
if [ "$manager" = systemd ]; then
  {
    cat <<'UNIT'
[Unit]
Description=Outpost enrolled machine connection
After=network-online.target
Wants=network-online.target
[Service]
UNIT
    printf 'User=%s\\n' "$(id -u)"
    cat <<'UNIT'
ExecStart=/bin/sh -c 'exec "$$HOME/.outpost/bin/outpost-terminal" connect'
Restart=on-failure
RestartSec=5s
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
  } > "$work/unit"
  as_root install -m 644 "$work/unit" /etc/systemd/system/outpost-machine.service
  as_root systemctl daemon-reload
  as_root systemctl enable outpost-machine.service
  as_root systemctl restart outpost-machine.service
else
  cat > "$work/service" <<'OPENRC'
#!/sbin/openrc-run
description="Outpost enrolled machine connection"
uid=$(stat -c %u /var/lib/outpost-machine)
command_user=$(stat -c %U /var/lib/outpost-machine)
if command -v getent >/dev/null; then account=$(getent passwd "$command_user")
else account=$(awk -F: -v uid="$uid" '$3 == uid {print; exit}' /etc/passwd); fi
HOME=$(printf '%s' "$account" | cut -d: -f6)
SHELL=$(printf '%s' "$account" | cut -d: -f7)
export HOME SHELL
command="$HOME/.outpost/bin/outpost-terminal"
command_args="connect"
supervisor="supervise-daemon"
respawn_delay=5
depend() { need net; }
OPENRC
  as_root install -m 755 "$work/service" /etc/init.d/outpost-machine
  as_root rc-update add outpost-machine default
  as_root rc-service outpost-machine restart
fi
echo 'Outpost machine enrolled. Follow software setup on the machine page.'
`
}
