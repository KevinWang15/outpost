import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function sshKeyPair(passphrase = '') {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-test-key-'))
  const path = join(directory, 'key')
  try {
    await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-Z', 'aes256-cbc', '-f', path])
    const [privateKey, publicKey] = await Promise.all([readFile(path, 'utf8'), readFile(`${path}.pub`, 'utf8')])
    return { private: privateKey, public: publicKey.trim() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
