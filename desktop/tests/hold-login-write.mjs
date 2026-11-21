// Test preload: hold the real atomic credential rename until the parent has quit.
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { once } from 'node:events'
import process from 'node:process'

const rename = fs.rename
fs.rename = async (from, to) => {
  if (basename(to) === 'server-logins.json') {
    const quit = once(process.stdin, 'end')
    process.stdout.write(JSON.stringify({ event: 'credentialWriteStarted' }) + '\n')
    await quit
  }
  return rename(from, to)
}
