import { createHash } from 'node:crypto'

// Synthetic targets and sessions for the v2 application screenshots.

export const demoDate = '2026-01-15T10:00:00.000Z'
export const demoHome = '/home/demo'
const environment = { home: demoHome, username: 'demo', uid: 1000, platform: 'linux', shell: '/bin/bash' }
const requirements = { backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'] }
export const targets = [
  { id: 'demo-atlas', kind: 'ssh', name: 'Atlas development', host: 'atlas.example.com', ...requirements, createdAt: demoDate },
  { id: 'demo-lab', kind: 'ssh', name: 'Research lab', host: 'lab.example.com', ...requirements, createdAt: demoDate },
  { id: 'demo-local', kind: 'local', name: 'This computer', ...requirements, createdAt: demoDate },
]

function identity(seed, tool) {
  const hex = createHash('sha256').update(`fictional-promo:${seed}`).digest('hex')
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  const id = tool === 'kimi' ? `session_${uuid.replaceAll('-', '')}` : uuid
  const key = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', kimi: 'KIMI_CODE_HOME' }[tool]
  const dir = { codex: '.codex', claude: '.claude', kimi: '.kimi-code' }[tool]
  return { cliSessionId: id, cliSessionEnv: { [key]: `${demoHome}/${dir}` } }
}

function session(id, name, tool, backend, state, status, rootDir) {
  return {
    id, name, tool, backend, ...identity(id, tool), rootDir, env: {}, args: '',
    createdAt: demoDate, lastConnectedAt: demoDate,
    socketPath: `${demoHome}/.outpost/sockets/${id}.sock`, status,
    activity: {
      state, updatedAt: demoDate, detail: null,
      completionId: state === 'finished' ? createHash('sha256').update(`demo-turn:${id}`).digest('hex') : null,
    },
  }
}

export function demoSessions() {
  return {
    'demo-atlas': [
      session('demo-dashboard', 'Build the dashboard', 'codex', 'tmux', 'working', 'detached', '/workspaces/demo-dashboard'),
      session('demo-api', 'Review the API', 'claude', 'tmux', 'finished', 'attached', '/workspaces/demo-api'),
      session('demo-ideas', 'Explore the next idea', 'kimi', 'dtach', 'idle', 'detached', '/workspaces/demo-lab'),
    ],
    'demo-lab': [
      session('demo-research', 'Explore a new workflow', 'kimi', 'dtach', 'working', 'detached', '/workspaces/demo-research'),
      session('demo-prototype', 'Prototype the interface', 'claude', 'tmux', 'idle', 'attached', '/workspaces/demo-prototype'),
    ],
    'demo-local': [
      session('demo-local-ui', 'Polish the interface', 'codex', 'tmux', 'idle', 'attached', '/workspaces/demo-ui'),
      session('demo-local-tests', 'Write the test plan', 'claude', 'dtach', 'finished', 'detached', '/workspaces/demo-tests'),
    ],
  }
}

export function softwareReport() {
  const ids = ['bash', 'python3', ...requirements.backends, ...requirements.tools]
  return {
    environment, checkedAt: demoDate, installation: null,
    software: ids.map(id => ({ id,
      status: 'installed', path: `/opt/demo/bin/${id}`, version: `${id} demo`, detail: null,
    })),
  }
}
