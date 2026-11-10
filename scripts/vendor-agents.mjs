// Fetch the pinned Codex ACP adapter for bundling into outpost-terminal.
// Only its self-contained dist/index.js (Apache-2.0, Node built-ins only) is
// used; Codex itself stays the target's own installed executable.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

const pins = JSON.parse(await readFile(new URL('../shared/chatAgents.json', import.meta.url), 'utf8'))
const { package: name, version, integrity } = pins.codex
const directory = new URL('../terminal-service/vendor/', import.meta.url)
const destination = new URL('codex-acp.js', directory)
const stamp = new URL('codex-acp.version', directory)

if ((await readFile(stamp, 'utf8').catch(() => '')) !== `${version}\n`) await vendor()

async function vendor() {
  const url = `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`Could not download ${name}@${version}: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = integrity.split('-')
  if (createHash(algorithm).update(archive).digest('base64') !== expected)
    throw new Error(`${name}@${version} does not match its pinned integrity`)

  // Read the two files we need from the tar stream (512-byte ustar records).
  const tar = gunzipSync(archive)
  const files = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const path = header.toString('utf8', 0, 100).replace(/\0.*$/s, '')
    if (!path) break
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8)
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '')
    files.set(prefix ? `${prefix}/${path}` : path, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const bundle = files.get('package/dist/index.js')
  const license = files.get('package/LICENSE')
  if (!bundle || !license) throw new Error(`${name}@${version} has an unexpected layout`)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL('codex-acp.LICENSE', directory), license)
  await writeFile(new URL('codex-acp.js.tmp', directory), bundle)
  await rename(new URL('codex-acp.js.tmp', directory), destination)
  await writeFile(stamp, `${version}\n`)
  console.log(`Vendored ${name}@${version}`)
}
