// `outpost-terminal agent deepseek DSH`: DeepSeek Harness's ACP server, with
// its advertised session/resume offered as the session/load the chat host
// uses. Everything else (prompts, approvals, updates, MCP servers) passes through.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function deepseekAgent(executable: string) {
  const child = spawn(executable, ['--profile', 'acp'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const initializing = new Set<unknown>()
  let resume = false
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      child.kill()
      return
    }
    if (initializing.has(message.id) && message.result) {
      initializing.delete(message.id)
      const capabilities = (message.result.agentCapabilities ??= {})
      resume = Boolean(capabilities.sessionCapabilities?.resume) && !capabilities.loadSession
      if (resume) capabilities.loadSession = true
    }
    process.stdout.write(`${JSON.stringify(message)}\n`)
  })
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      child.kill()
      return
    }
    if (message.method === 'initialize' && 'id' in message) initializing.add(message.id)
    if (message.method === 'session/load' && resume) message.method = 'session/resume'
    child.stdin.write(`${JSON.stringify(message)}\n`)
  })
  process.stdin.on('end', () => child.stdin.end())
  // A dead native server must close the ACP transport even while ours stays open.
  const code = await new Promise<number>(resolve => child.on('exit', status => resolve(status ?? 1)))
  process.exit(code)
}
