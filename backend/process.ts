import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { AppError } from './errors'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface Command {
  executable: string
  args: string[]
  label: string
  /** One alternate invocation, available only to explicitly read-only callers.
   * The executable, input bytes, environment and deadline remain unchanged. */
  retry?: { args: string[]; when(result: CommandResult): boolean }
}
interface CommandOptions {
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onOutput?: (text: string) => void
  /** Allow the transport's single recovery attempt. Mutations default to false. */
  readOnly?: boolean
  maxOutputBytes?: number
}

/** Run a bounded command. A transport-provided recovery is attempted once,
 * only for explicitly read-only callers with buffered output. */
export async function runCommand(
  command: Command,
  input: string | Uint8Array,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const deadline = performance.now() + (options.timeoutMs ?? 30_000)
  const result = await runCommandOnce(command, input, options)
  if (!options.readOnly || result.stdout.length !== 0 || options.onOutput || !command.retry?.when(result)) return result
  return runCommandOnce({ ...command, args: command.retry.args }, input, {
    ...options,
    timeoutMs: deadline - performance.now(),
  })
}

function runCommandOnce(command: Command, input: string | Uint8Array, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const aborted = () => new AppError(`${command.label} operation aborted`, 502)
    const timedOut = () => new AppError(`${command.label} operation timed out. Check the target and retry.`, 504)
    if (options.signal?.aborted) return reject(aborted())
    const timeoutMs = options.timeoutMs ?? 30_000
    if (timeoutMs <= 0) return reject(timedOut())
    // Give short-lived workers their own process group. Terminal services are
    // started independently by the runtime and never belong to these groups.
    const child = spawn(command.executable, command.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: options.env,
    })
    const stdout: Buffer[] = []
    const decoder = new StringDecoder('utf8')
    let size = 0,
      stderr = '',
      settled = false
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const fail = (error: AppError) => {
      if (settled) return
      settled = true
      cleanup()
      stop()
      // Descendants may retain these pipes after their parent is dead; request
      // deadlines must not wait for the child's eventual close event.
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      reject(error)
    }
    const cancel = () => fail(aborted())
    const timer = setTimeout(() => fail(timedOut()), timeoutMs)
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (settled) return
      if (options.onOutput) options.onOutput(decoder.write(chunk))
      else {
        size += chunk.length
        if (size > (options.maxOutputBytes ?? 4_000_000))
          fail(new AppError('Target response exceeded the size limit', 502))
        else stdout.push(chunk)
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
      if (options.onOutput) options.onOutput(decoder.end())
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr })
    })
    child.stdin.end(input)
  })
}
