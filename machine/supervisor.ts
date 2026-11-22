import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { statePath } from './state'
const execute = promisify(execFile)

const systemd = '/etc/systemd/system/outpost-machine.service'
const openrc = '/etc/init.d/outpost-machine'
export type Supervisor = 'systemd' | 'openrc'

async function admin(program: string, ...args: string[]) {
  if (process.getuid?.() === 0) await execute(program, args, { timeout: 30_000 })
  else await execute('sudo', ['-n', program, ...args], { timeout: 30_000 })
}

const systemdUnit = () => `[Unit]
Description=Outpost enrolled machine connection
After=network-online.target
Wants=network-online.target
[Service]
User=${process.getuid!()}
ExecStart=/bin/sh -c 'exec "$$HOME/.outpost/bin/outpost-terminal" connect'
Restart=on-failure
RestartSec=5s
KillMode=process
[Install]
WantedBy=multi-user.target
`
const openrcService = `#!/sbin/openrc-run
description="Outpost enrolled machine connection"
uid=$(stat -c %u /var/lib/outpost-machine)
command_user=$(stat -c %U /var/lib/outpost-machine)
if command -v getent >/dev/null; then account=$(getent passwd "$command_user")
else account=$(awk -F: -v uid="$uid" '$3 == uid {print; exit}' /etc/passwd); fi
HOME=$(printf '%s\\n' "$account" | cut -d: -f6)
SHELL=$(printf '%s\\n' "$account" | cut -d: -f7)
export HOME SHELL
command="$HOME/.outpost/bin/outpost-terminal"
command_args="connect"
supervisor="supervise-daemon"
respawn_delay=5
depend() { need net; }
`

/** Activate and remove the machine's boot service under the same ownership lock. */
export async function installSupervisor(manager: Supervisor) {
  const definition = statePath('bin', '.service-' + randomUUID())
  try {
    writeFileSync(definition, manager === 'systemd' ? systemdUnit() : openrcService, { mode: 0o600, flag: 'wx' })
    if (manager === 'systemd') {
      await admin('install', '-m', '644', definition, systemd)
      await admin('systemctl', 'daemon-reload')
      await admin('systemctl', 'enable', 'outpost-machine.service')
      await admin('systemctl', 'restart', 'outpost-machine.service')
    } else {
      await admin('install', '-m', '755', definition, openrc)
      await admin('rc-update', 'add', 'outpost-machine', 'default')
      await admin('rc-service', 'outpost-machine', 'restart')
    }
  } finally {
    rmSync(definition, { force: true })
  }
}

export async function removeSupervisor() {
  if (existsSync(systemd)) {
    await admin('systemctl', 'disable', '--now', 'outpost-machine.service')
    await admin('rm', '-f', systemd)
    await admin('systemctl', 'daemon-reload')
  } else if (existsSync(openrc)) {
    await admin('rc-service', 'outpost-machine', 'stop')
    await admin('rc-update', 'del', 'outpost-machine', 'default')
    await admin('rm', '-f', openrc)
  }
}
