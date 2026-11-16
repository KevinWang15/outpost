// `outpost-terminal agent antigravity AGY`: Antigravity CLI's ACP server,
// pinning its `.gemini` store and mapping ACP `systemPrompt` append and HTTP
// MCP server capabilities onto `agy acp`'s native `_meta.antigravity` surface.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export async function antigravityAgent(executable: string) {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR
  const args = geminiDir ? ['acp', '--gemini-dir', geminiDir] : ['acp']
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  const initializing = new Set<unknown>()
  let systemPromptMeta = false
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      child.kill()
      return
    }
    if (initializing.has(message.id) && isRecord(message.result)) {
      initializing.delete(message.id)
      const capabilities = (message.result.agentCapabilities ??= {}) as Record<string, unknown>
      const meta =
        isRecord(capabilities._meta) && isRecord(capabilities._meta.antigravity) ? capabilities._meta.antigravity : null
      const sessionCapabilities = (capabilities.sessionCapabilities ??= {}) as Record<string, unknown>
      if (meta && isRecord(meta.systemPrompt) && meta.systemPrompt.append && !sessionCapabilities.systemPrompt) {
        systemPromptMeta = true
        sessionCapabilities.systemPrompt = {}
      }
      const mcpCapabilities = (capabilities.mcpCapabilities ??= {}) as Record<string, unknown>
      mcpCapabilities.http ??= true
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
    if (
      (message.method === 'session/new' || message.method === 'session/load') &&
      systemPromptMeta &&
      isRecord(message.params)
    ) {
      const system = message.params.systemPrompt
      if (isRecord(system) && system.mode === 'append' && Array.isArray(system.content)) {
        const text = system.content
          .filter(
            (block): block is { type: 'text'; text: string } =>
              isRecord(block) && block.type === 'text' && typeof block.text === 'string',
          )
          .map(block => block.text)
          .join('\n')
        const meta = (isRecord(message.params._meta) ? message.params._meta : {}) as Record<string, unknown>
        const antigravity = (isRecord(meta.antigravity) ? meta.antigravity : {}) as Record<string, unknown>
        message.params._meta = { ...meta, antigravity: { ...antigravity, systemPrompt: { append: text } } }
        delete message.params.systemPrompt
      }
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  })
  process.stdin.on('end', () => child.stdin.end())
  // A dead native server must close the ACP transport even while ours stays open.
  const code = await new Promise<number>(resolve => child.on('exit', status => resolve(status ?? 1)))
  process.exit(code)
}
