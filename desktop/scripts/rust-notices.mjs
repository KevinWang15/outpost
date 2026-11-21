import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export async function rustNotices(desktop, output) {
  const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1].trim()
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--locked', '--filter-platform', host, '--format-version', '1'], {
      cwd: desktop,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  )
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]))
  const ids = new Set()
  function visit(id) {
    if (ids.has(id)) return
    ids.add(id)
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some(k => k.kind === null)) visit(dep.pkg)
  }
  visit(metadata.resolve.root)
  const dependencies = metadata.packages.filter(p => ids.has(p.id) && p.source)
  const index = []
  for (const pkg of dependencies) {
    let source = dirname(pkg.manifest_path)
    let files = (await readdir(source, { withFileTypes: true }))
      .filter(f => f.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(f.name))
      .map(f => join(source, f.name))
    if (pkg.license_file && existsSync(join(source, pkg.license_file))) files.push(join(source, pkg.license_file))
    if (pkg.source.startsWith('git+') && !files.length) {
      // Workspace members can inherit the repository license.
      for (let i = 0; i < 3 && !files.length; i++) {
        source = dirname(source)
        files = (await readdir(source, { withFileTypes: true }))
          .filter(f => f.isFile() && /^(?:license|copying)(?:[._-]|$)/i.test(f.name))
          .map(f => join(source, f.name))
      }
    }
    if (pkg.name === 'gpui') {
      const iconLicense = join(dirname(pkg.manifest_path), 'assets', 'lucide', 'LICENSE')
      if (existsSync(iconLicense)) files.push(iconLicense)
    }
    const label = pkg.name + '-' + pkg.version,
      path = join(output, label)
    await mkdir(path, { recursive: true })
    for (const file of new Set(files)) {
      const name = file.includes('lucide') ? 'Lucide-LICENSE' : basename(file)
      await copyFile(file, join(path, name))
    }
    index.push([label, pkg.license || 'See included license', pkg.repository || pkg.source].join('  '))
  }
  await writeFile(join(output, 'INDEX.txt'), index.sort().join('\n') + '\n')
}
