import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { AppError } from './errors'

/** Only a missing file starts a new store. Unreadable or incompatible state is left in place. */
export async function readStateFile<T>(path: string, empty: T, valid: (value: unknown) => value is T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw error
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new AppError(`Invalid JSON in ${basename(path)}. No data was modified.`, 409)
  }
  if (!valid(data))
    throw new AppError(`Invalid ${basename(path)}. Expected the current schema; no data was modified.`, 409)
  return data
}
