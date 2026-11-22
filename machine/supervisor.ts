import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
const execute = promisify(execFile)

/** Release the fixed boot service installed by the outbound setup command. */
export async function removeSupervisor() {
  const systemd = '/etc/systemd/system/outpost-machine.service'
  const openrc = '/etc/init.d/outpost-machine'
  const admin = async (program: string, ...args: string[]) => {
    if (process.getuid?.() === 0) await execute(program, args, { timeout: 30_000 })
    else await execute('sudo', ['-n', program, ...args], { timeout: 30_000 })
  }
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
