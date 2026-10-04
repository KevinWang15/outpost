import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AppError } from './errors'

export interface Command { executable: string; args: string[]; label: string; expandHome?: boolean }
interface CommandOptions {
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onOutput?: (text: string) => void
}
export function runCommand(command: Command, script: string, options: CommandOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const aborted = () => new AppError(`${command.label} operation aborted`, 502)
    if (options.signal?.aborted) return reject(aborted())
    // Give short-lived workers their own POSIX group. Persistence servers are
    // launched independently by the runtime and never belong to these groups.
    const child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: options.env, windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32') {
        const executable = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
        const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        const deadline = setTimeout(() => { killer.kill(); child.kill('SIGKILL') }, 5000).unref()
        killer.once('error', () => { clearTimeout(deadline); child.kill('SIGKILL') })
        killer.once('exit', code => { clearTimeout(deadline); if (code !== 0) child.kill('SIGKILL') })
        killer.unref()
      } else {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch { child.kill('SIGKILL') }
      }
    }
    const fail = (error: AppError) => {
      if (settled) return
      settled = true
      cleanup()
      stop()
      // Descendants may retain these pipes even after their parent is dead.
      // Request deadlines must not wait for the child's eventual close event.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      reject(error)
    }
    const cancel = () => fail(aborted())
    const timer = setTimeout(() => fail(new AppError(`${command.label} operation timed out. Check the target and retry.`, 504)), options.timeoutMs ?? 30_000)
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (settled) return
      if (options.onOutput) options.onOutput(chunk)
      else {
        stdout += chunk
        if (stdout.length > 4_000_000) fail(new AppError('Target response exceeded the size limit', 502))
      }
    })
    child.stderr.on('data', chunk => {
      if (settled) return
      if (options.onOutput) options.onOutput(chunk)
      else stderr = (stderr + chunk).slice(-16_000)
    })
    child.on('error', error => fail(new AppError(`Could not launch ${command.label}: ${error.message}`, 502)))
    child.stdin.on('error', () => {})
    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(script)
  })
}
export async function runProtocol<T>(command: Command, script: string, options: CommandOptions = {}): Promise<T> {
  const { code, stdout, stderr } = await runCommand(command, script, options)
  const line = stdout.split('\n').reverse().find(line => line.startsWith('OUTPOST_RESULT:'))
  if (line) {
    let result
    try { result = JSON.parse(line.slice('OUTPOST_RESULT:'.length)) } catch { throw new AppError('Invalid response from target', 502) }
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 2) {
      throw new AppError('Invalid response from target', 502)
    }
    if (result.ok === false && result.error && typeof result.error === 'object'
      && Object.keys(result.error).length === 2 && typeof result.error.message === 'string'
      && Number.isInteger(result.error.status) && result.error.status >= 400 && result.error.status <= 599) {
      throw new AppError(result.error.message, result.error.status)
    }
    if (result.ok !== true || !Object.hasOwn(result, 'data')) throw new AppError('Invalid response from target', 502)
    if (code === 0) return result.data
  }
  throw new AppError(`${command.label} failed (${code ?? 'disconnected'}). ${stderr.trim() || 'No response. Check access and Required Software.'}`, 502)
}
