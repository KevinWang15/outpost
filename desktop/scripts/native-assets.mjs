import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch } from 'builder-util'

const dependency = fileURLToPath(new URL('../node_modules/node-pty/', import.meta.url))

/** node-gyp rebuild removes DLLs placed by npm's postinstall. Restore the pinned
 * ConPTY runtime beside each compiled binding, for development and installers. */
async function copyConpty(destination, architecture) {
  const versions = await readdir(join(dependency, 'third_party/conpty'))
  if (versions.length !== 1) throw new Error('Expected one bundled ConPTY runtime in node-pty.')
  const source = join(dependency, 'third_party/conpty', versions[0], `win10-${architecture}`)
  let bindings = 0
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/win32-${architecture}`]) {
    const binding = join(destination, directory)
    if (!(await stat(join(binding, 'conpty.node')).catch(() => null))) continue
    bindings++
    await mkdir(join(binding, 'conpty'), { recursive: true })
    for (const file of ['conpty.dll', 'OpenConsole.exe']) await cp(join(source, file), join(binding, 'conpty', file))
  }
  if (!bindings) throw new Error(`Missing node-pty ConPTY binding for ${architecture}.`)
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const dependency = join(context.appOutDir, 'resources/app.asar.unpacked/node_modules/node-pty')
  await copyConpty(dependency, Arch[context.arch])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.platform === 'win32')
  await copyConpty(dependency, process.arch)
