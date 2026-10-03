import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors'

const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
let running = 0
async function key(password: string, salt: Buffer): Promise<Buffer> {
  if (running >= 4) throw new AppError('Sign-in is busy. Please try again shortly.', 503)
  running++
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, options, (error, result) => error ? reject(error) : resolve(result))) }
  finally { running-- }
}
export function validatePassword(password: string) {
  if (password.length < 8 || password.length > 1024) throw new AppError('Password must be between 8 and 1024 characters.', 400)
}
export async function hashPassword(password: string) {
  validatePassword(password)
  const salt = randomBytes(16), digest = await key(password, salt)
  return `scrypt$131072$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`
}
export async function verifyPassword(password: string, encoded: string) {
  const match = /^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded)
  if (!match) throw new Error('Invalid stored password hash')
  const digest = await key(password, Buffer.from(match[1], 'base64url'))
  return timingSafeEqual(digest, Buffer.from(match[2], 'base64url'))
}
