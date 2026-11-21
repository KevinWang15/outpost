// Package the host architecture. CI uses a matching Rust target and Node runtime for each installer.
import { rustNotices } from './rust-notices.mjs'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const root = dirname(desktop.replace(/\/$/, ''))
const { version } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
const profile = process.argv.includes('--debug') ? 'debug' : 'release'
const cargo = JSON.parse(
  execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: desktop, encoding: 'utf8' }),
)
const bin = join(cargo.target_directory, profile, process.platform === 'win32' ? 'outpost.exe' : 'outpost')
const output = join(desktop, 'release')
const staging = await mkdtemp(join(tmpdir(), 'outpost-package-'))
await mkdir(output, { recursive: true })
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
const copy = async (src, dest) => {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
}
async function resources(dir) {
  await copy(join(desktop, 'dist', 'outpost-helper.cjs'), join(dir, 'outpost-helper.cjs'))
  await copy(process.execPath, join(dir, basename(process.execPath)))
  const prefix = dirname(process.execPath)
  const nodeLicense = [join(prefix, 'LICENSE'), join(prefix, '..', 'LICENSE'), join(prefix, 'LICENSE.txt')].find(
    existsSync,
  )
  if (!nodeLicense) throw Error('Package with an official Node.js distribution containing its LICENSE.')
  await copy(nodeLicense, join(dir, 'licenses', 'Node.txt'))
  for (const [folder, file] of [
    ['ws', 'LICENSE'],
    ['@xterm/headless', 'LICENSE'],
    ['@xterm/addon-serialize', 'LICENSE'],
    ['typebox', 'license'],
  ]) {
    const modules = join(desktop, 'node_modules', folder)
    const source =
      [file, 'LICENSE', 'LICENSE.txt', 'license', 'license.md'].map(v => join(modules, v)).find(existsSync) ??
      (folder.startsWith('@xterm/') ? join(desktop, 'packaging', 'licenses', 'xterm.txt') : undefined)
    if (!source) throw Error('Missing license for ' + folder)
    await copy(source, join(dir, 'licenses', folder.replaceAll('/', '-') + '.txt'))
  }
  await copy(join(root, 'THIRD_PARTY_NOTICES.md'), join(dir, 'licenses', 'Outpost notices.md'))
  await copy(join(root, 'LICENSE'), join(dir, 'licenses', 'Outpost.txt'))
  await rustNotices(desktop, join(dir, 'licenses', 'rust'))
}
try {
  if (process.platform === 'darwin') {
    const app = join(staging, 'Outpost.app'),
      contents = join(app, 'Contents'),
      res = join(contents, 'Resources')
    await resources(res)
    await copy(bin, join(contents, 'MacOS', 'Outpost'))
    await chmod(join(contents, 'MacOS', 'Outpost'), 0o755)
    await chmod(join(res, 'node'), 0o755)
    const png = await readFile(join(root, 'public', 'outpost.png')),
      head = Buffer.alloc(16)
    head.write('icns')
    head.writeUInt32BE(16 + png.length, 4)
    head.write('ic09', 8)
    head.writeUInt32BE(8 + png.length, 12)
    await writeFile(join(res, 'outpost.icns'), Buffer.concat([head, png]))
    const plist = await readFile(join(desktop, 'packaging', 'Info.plist'), 'utf8')
    await writeFile(join(contents, 'Info.plist'), plist.replaceAll('@VERSION@', version))
    run('codesign', ['--force', '--sign', '-', join(res, 'node')])
    run('codesign', ['--force', '--sign', '-', app])
    const base = join(output, `Outpost-${version}-mac-${process.arch}`)
    run('ditto', ['-c', '-k', '--keepParent', app, base + '.zip'])
    if (!process.argv.includes('--app-only'))
      run('hdiutil', ['create', '-ov', '-format', 'UDZO', '-volname', 'Outpost', '-srcfolder', staging, base + '.dmg'])
    run('ditto', [app, join(output, 'Outpost.app')])
  } else if (process.platform === 'win32') {
    const app = join(staging, 'Outpost')
    await resources(join(app, 'resources'))
    await copy(bin, join(app, 'Outpost.exe'))
    const ico = Buffer.alloc(22),
      png = await readFile(join(root, 'public', 'outpost-256.png'))
    ico.writeUInt16LE(1, 2)
    ico.writeUInt16LE(1, 4)
    ico.writeUInt16LE(1, 10)
    ico.writeUInt16LE(32, 12)
    ico.writeUInt32LE(png.length, 14)
    ico.writeUInt32LE(22, 18)
    const icon = join(staging, 'outpost.ico')
    await writeFile(icon, Buffer.concat([ico, png]))
    run(process.env.MAKENSIS || 'makensis', [
      `/DAPP=${app}`,
      `/DICON=${icon}`,
      `/DOUT=${join(output, `Outpost-${version}-windows-${process.arch}.exe`)}`,
      join(desktop, 'packaging', 'installer.nsi'),
    ])
  } else throw Error('Desktop installers are available for macOS and Windows.')
} finally {
  await rm(staging, { recursive: true, force: true })
}
