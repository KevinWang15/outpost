import { readFileSync, readdirSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { quote } from './shell'

// The native connector is Python that runs on your computer (macOS, or WSL on
// Windows). The server serves it as a zipapp and a one-line installer.
const directory = new URL('../connector/', import.meta.url)
export const connectorVersion = /^VERSION = '([^']+)'$/m.exec(readFileSync(new URL('outpost_connector/__init__.py', directory), 'utf8'))![1]

function files(path: string, prefix = ''): [string, Buffer][] {
  return readdirSync(new URL(path, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : files(`${path}${entry.name}/`, `${prefix}${entry.name}/`)
    return entry.name.endsWith('.py') ? [[`${prefix}${entry.name}`, readFileSync(new URL(`${path}${entry.name}`, directory))] as [string, Buffer]] : []
  })
}

/** A stored (uncompressed) ZIP; Python's zipimport runs it as `python3 outpost-connector.pyz`. */
export function zip(entries: [string, Buffer][]) {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const path = Buffer.from(name)
    const checksum = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8)
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(path.length, 28)
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    local.push(header, path, data)
    central.push(record, path)
    offset += header.length + path.length + data.length
  }
  const size = central.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

export const connectorArchive = zip([
  ['__main__.py', Buffer.from('from outpost_connector.cli import main\nmain()\n')],
  ...files('outpost_connector/', 'outpost_connector/'),
])

/** `curl -fsSL <origin>/connector/install.sh | bash` — installs and trusts this server. */
export function installScript(origin: string) {
  return `#!/usr/bin/env bash
# Outpost connector installer. Installs into ~/.outpost-connector and trusts ${origin}.
set -euo pipefail
server=${quote(origin)}
python=$(command -v python3 || true)
if [ -z "$python" ] || ! "$python" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  if [ "$(uname -s)" = Darwin ]; then echo 'Outpost needs Python 3.9 or newer. Install it with: xcode-select --install' >&2
  else echo 'Outpost needs Python 3.9 or newer. Install it with: sudo apt install python3' >&2; fi
  exit 1
fi
directory="$HOME/.outpost-connector"
mkdir -p "$directory"
chmod 700 "$directory"
download=$(mktemp "$directory/.download.XXXXXX")
trap 'rm -f "$download"' EXIT
curl -fsSL "$server/connector/outpost-connector.pyz" -o "$download"
"$python" "$download" install --server "$server" --archive "$download"
`
}

export const installCommand = (origin: string) => `curl -fsSL ${quote(`${origin}/connector/install.sh`)} | bash`
