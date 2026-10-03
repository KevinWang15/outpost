import { createHash } from 'node:crypto'
import { requiredSoftware } from '../../shared/session-manager.ts'

export const captureTime = '2026-10-03T09:30:00.000Z'
const createdAt = '2026-10-03T08:00:00.000Z'
const requirements = { backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'] }
export const targets = [
  { id: 'readme-atlas', kind: 'ssh', name: 'Atlas development', host: 'atlas.example.com', ...requirements, createdAt },
  { id: 'readme-lab', kind: 'ssh', name: 'Research lab', host: 'lab.example.com', ...requirements, createdAt },
  { id: 'readme-local', kind: 'local', name: 'This computer', ...requirements, createdAt },
]

function identity(seed, tool) {
  const hex = createHash('sha256').update(`readme-example:${seed}`).digest('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  const key = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', kimi: 'KIMI_CODE_HOME' }[tool]
  const directory = { codex: '.codex', claude: '.claude', kimi: '.kimi-code' }[tool]
  return { cliSessionId: tool === 'kimi' ? `session_${uuid.replaceAll('-', '')}` : uuid, cliSessionEnv: { [key]: `/srv/example-tools/${directory}` } }
}

function session(id, name, tool, backend, state, status, rootDir) {
  return {
    id, name, tool, backend, rootDir, ...identity(id, tool), env: {}, args: '', createdAt,
    lastConnectedAt: '2026-10-03T09:24:00.000Z', socketPath: `/srv/example-sessions/${id}.sock`, status,
    activity: { state, updatedAt: captureTime, detail: null, completionId: state === 'finished' ? createHash('sha256').update(id).digest('hex') : null },
  }
}

const sessions = {
  'readme-atlas': [
    session('readme-dashboard', 'Build the dashboard', 'codex', 'tmux', 'working', 'detached', '/srv/projects/dashboard'),
    session('readme-api', 'Review the API', 'claude', 'tmux', 'finished', 'attached', '/srv/projects/api'),
    session('readme-research', 'Explore the next idea', 'kimi', 'dtach', 'idle', 'detached', '/srv/projects/research'),
  ],
  'readme-lab': [session('readme-prototype', 'Prototype a new workflow', 'kimi', 'dtach', 'working', 'detached', '/srv/projects/prototype')],
  'readme-local': [session('readme-local-ui', 'Polish the interface', 'claude', 'tmux', 'idle', 'attached', '/home/dev/projects/interface')],
}

function get(target, id) {
  const found = sessions[target.id]?.find(item => item.id === id)
  if (!found) throw new Error('Unknown example session')
  return structuredClone(found)
}

export const service = {
  async list(target) { return { sessions: structuredClone(sessions[target.id]), registryPath: target.kind === 'ssh' ? '/root/.outpost/sessions.json' : '/home/dev/.outpost/sessions.json' } },
  async get(target, id) { return get(target, id) },
  async directories(_target, path) {
    return { directories: ['/srv/projects/dashboard/', '/srv/projects/dashboard-design/', '/srv/projects/api/', '/srv/projects/research/'].filter(directory => directory.startsWith(path)), truncated: false }
  },
  async search(target, input) {
    const matches = [
      { ...identity('readme-dashboard', 'codex'), tool: 'codex', rootDir: '/srv/projects/dashboard', title: 'Make API retries predictable', excerpt: 'Use a short backoff for transient network failures. Keep the retry policy bounded and easy to test.', managedSessionIds: ['readme-dashboard'], createdAt, updatedAt: '2026-10-03T09:20:00.000Z' },
      { ...identity('readme-earlier-api', 'claude'), tool: 'claude', rootDir: '/srv/projects/api', title: 'Review retry handling in the API client', excerpt: 'Show a useful error after the final retry, and preserve the request context for the next attempt.', managedSessionIds: [], createdAt, updatedAt: '2026-10-03T09:10:00.000Z' },
    ]
    if (target.id !== 'readme-atlas') return { sessions: [], truncated: false, warnings: [] }
    return { sessions: matches.filter(match => (!input.tool || match.tool === input.tool) && `${match.title} ${match.excerpt}`.toLowerCase().includes(input.query.toLowerCase())), truncated: false, warnings: [] }
  },
  async pasteImage(target, id) {
    const current = get(target, id)
    const path = `/srv/example-images/${id}/dashboard-concept.png`
    return { path, reference: path, injected: current.backend === 'tmux' }
  },
}

export const software = {
  async inspect(target) {
    const local = target.kind === 'local'
    return {
      environment: { home: local ? '/home/dev' : '/root', username: local ? 'dev' : 'root', uid: local ? 1000 : 0, platform: 'linux', shell: '/bin/bash' },
      checkedAt: captureTime,
      software: requiredSoftware(target, 'linux').map(id => ({ id, status: 'installed', path: `/usr/local/bin/${id}`, version: `${id} example`, detail: null })),
    }
  },
}

export const desktop = {
  async available() { return { os: 'linux', terminals: [], recommendedId: null } },
}
