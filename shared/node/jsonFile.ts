import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Replace `path` with `value` as JSON in one rename, so readers see the old or
 * the new file and never a partial one. Owner-only: the directory is created
 * 0700 and the file 0600. A failed write leaves no temporary file behind. */
export async function writeJsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
