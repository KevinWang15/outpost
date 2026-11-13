// A disposable machine state directory for the machine's own modules, run in-process.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import type { HarnessId } from '../../shared/harnesses'
import type { SessionRecord } from '../../shared/model'
import { harness } from '../../machine/harnesses'
import { changeRegistry } from '../../machine/registry'
import { state } from '../../machine/state'

export const uuid = '12345678-1234-4123-8123-123456789012'

/** Point the machine modules at a fresh state directory below a fresh home. */
export function machine(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'outpost-machine-')))
  const previous = state.directory
  state.directory = join(home, '.outpost')
  t.after(() => {
    state.directory = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** A session record of `tool`, with its store below `home`. */
export function record(
  home: string,
  tool: HarnessId,
  conversation: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  const adapter = harness(tool)
  return {
    id: crypto.randomUUID(),
    name: `${tool} ${crypto.randomUUID().slice(0, 8)}`,
    tool,
    rootDir: home,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastConnectedAt: null,
    storage: adapter.storage(join(home, tool)),
    delivery: 'auto',
    config: { revision: 1, env: {}, args: '', instructions: null },
    conversations: [{ id: conversation, startedAt: '2026-10-01T00:00:00.000Z', movedTo: null }],
    ...overrides,
  }
}

export async function register(...sessions: SessionRecord[]) {
  await changeRegistry(registry => void registry.sessions.push(...sessions))
}

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** The fixture coding tools on this process's PATH, with their stores below
 * `home`, as on a machine. Test files run in separate processes. */
export function tools(t: TestContext, home: string) {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const tool of ['claude', 'codex', 'kimi', 'dsh']) {
    copyFileSync(join(fixtures, 'coding-tool-fixture.py'), join(bin, tool))
    chmodSync(join(bin, tool), 0o700)
  }
  copyFileSync(join(fixtures, 'acp-agent-fixture.py'), join(bin, 'acp-agent-fixture'))
  chmodSync(join(bin, 'acp-agent-fixture'), 0o700)
  const previous = { ...process.env }
  // Never the binding of a session these tests may run in.
  for (const key of Object.keys(process.env)) if (key.startsWith('OUTPOST_')) delete process.env[key]
  Object.assign(process.env, {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIMI_CODE_HOME: join(home, '.kimi-code'),
    DSH_HOME: join(home, '.dsh'),
  })
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  })
  return bin
}
