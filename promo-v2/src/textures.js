// Canvas drawing for everything that appears *inside* the 3D world:
// floating session terminals, device screens, and adapter modules.
import * as THREE from 'three'

export const C = {
  bg: '#0a1222', glass: 'rgba(12, 20, 38, 0.92)', line: 'rgba(148, 178, 230, 0.22)',
  text: '#dbe6f7', dim: '#7d8fb0', blue: '#4f8dff', cyan: '#2fd6f0', mint: '#34d399', amber: '#fbbf24', red: '#fb5a6e',
}
const TOOL_COLOR = { Codex: C.cyan, 'Claude Code': '#f6a26b', Kimi: C.mint, Custom: C.amber }
const STATUS = {
  working: { label: 'Working', color: C.blue },
  idle: { label: 'Idle', color: C.dim },
  waiting: { label: 'Waiting for you', color: C.amber },
  stopped: { label: 'Stopped', color: C.red },
  done: { label: 'Done', color: C.mint },
  unknown: { label: '?', color: C.dim },
}
const MONO = '"JetBrains Mono", monospace'
const SANS = '"Inter", sans-serif'

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// A texture that only re-uploads when its drawing state changes.
export class Painted {
  constructor(width, height, draw) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')
    this.draw = draw
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 4
    this.key = ''
  }
  update(state) {
    const key = JSON.stringify(state)
    if (key === this.key) return
    this.key = key
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.draw(this.ctx, this.canvas.width, this.canvas.height, state)
    this.texture.needsUpdate = true
  }
}

function spinner(ctx, x, y, r, phase, color) {
  ctx.strokeStyle = color
  ctx.lineWidth = r * 0.38
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(x, y, r, phase, phase + Math.PI * 1.4)
  ctx.stroke()
}

function statusChip(ctx, x, y, s, phase, scale = 1) {
  const st = STATUS[s.status] ?? STATUS.idle
  const label = s.statusLabel ?? st.label
  ctx.font = `600 ${22 * scale}px ${SANS}`
  const w = ctx.measureText(label).width + 58 * scale
  const h = 40 * scale
  roundRect(ctx, x - w, y, w, h, h / 2)
  ctx.fillStyle = st.color + '26'
  ctx.fill()
  ctx.strokeStyle = st.color + '88'
  ctx.lineWidth = 2
  ctx.stroke()
  const cx = x - w + 22 * scale
  const cy = y + h / 2
  if (s.status === 'working') spinner(ctx, cx, cy, 8 * scale, phase, st.color)
  else {
    ctx.fillStyle = st.color
    ctx.beginPath()
    ctx.arc(cx, cy, 6.5 * scale, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = st.color
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx + 18 * scale, cy + 1)
}

// Floating terminal panel representing one coding session.
// state: { tool, title, lines: [[text, color?]], typed, status, phase, cursor, alert }
export function drawSession(ctx, w, h, s) {
  const accent = TOOL_COLOR[s.tool] ?? C.blue
  const border = s.alert ? C.red : s.status === 'waiting' ? C.amber : accent
  roundRect(ctx, 6, 6, w - 12, h - 12, 26)
  ctx.fillStyle = C.glass
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = border + (s.highlight ? 'ff' : '99')
  ctx.stroke()
  // Title bar
  ctx.save()
  roundRect(ctx, 6, 6, w - 12, 76, 26)
  ctx.clip()
  ctx.fillStyle = 'rgba(255,255,255,0.045)'
  ctx.fillRect(0, 0, w, 82)
  ctx.restore()
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = ['#ff5f57', '#febc2e', '#28c840'][i] + 'cc'
    ctx.beginPath()
    ctx.arc(40 + i * 28, 44, 8.5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.textBaseline = 'middle'
  ctx.font = `700 27px ${SANS}`
  ctx.fillStyle = accent
  ctx.fillText(s.tool, 136, 44)
  const toolWidth = ctx.measureText(s.tool).width
  ctx.font = `500 25px ${SANS}`
  ctx.fillStyle = C.dim
  if (s.title) ctx.fillText(`· ${s.title}`, 136 + toolWidth + 12, 45)
  // Body lines with a typewriter reveal across all lines.
  ctx.font = `400 25px ${MONO}`
  let budget = s.typed ?? Infinity
  let y = 128
  let last = null
  for (const [text, color] of s.lines ?? []) {
    if (budget <= 0) break
    const shown = text.slice(0, budget)
    budget -= text.length
    ctx.fillStyle = color ?? C.text
    ctx.fillText(shown, 40, y)
    last = { x: 40 + ctx.measureText(shown).width, y }
    y += 42
  }
  if (s.cursor && last && Math.floor((s.phase ?? 0) * 1.6) % 2 === 0) {
    ctx.fillStyle = C.text
    ctx.fillRect(last.x + 4, last.y - 15, 13, 28)
  }
  if (s.status) statusChip(ctx, w - 30, h - 70, s, s.phase ?? 0)
  if (s.alert) {
    ctx.font = `700 26px ${SANS}`
    ctx.fillStyle = C.red
    ctx.fillText(s.alert, 40, h - 50)
  }
  if (s.question) {
    ctx.fillStyle = 'rgba(6,10,20,0.62)'
    roundRect(ctx, 6, 6, w - 12, h - 12, 26)
    ctx.fill()
    ctx.font = `800 150px ${SANS}`
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(219,230,247,0.85)'
    ctx.fillText('?', w / 2, h / 2 + 8)
    ctx.textAlign = 'left'
  }
}

// The screen of a laptop or desktop: either the manager dashboard or an attached terminal.
export function drawScreen(ctx, w, h, s) {
  ctx.fillStyle = '#060a14'
  ctx.fillRect(0, 0, w, h)
  if (s.off) return
  if (s.mode === 'dashboard' && s.image) {
    ctx.drawImage(s.image, 0, 0, s.image.width, s.image.height * 0.8, 0, 0, w, h)
  } else if (s.mode === 'terminal') {
    ctx.fillStyle = '#0d1628'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#16223a'
    ctx.fillRect(0, 0, w, 64)
    ctx.textBaseline = 'middle'
    ctx.font = `600 28px ${SANS}`
    ctx.fillStyle = C.cyan
    ctx.fillText('Codex', 32, 33)
    ctx.fillStyle = C.dim
    ctx.font = `500 26px ${SANS}`
    ctx.fillText('· Build the dashboard  ·  atlas.example.com', 120, 34)
    ctx.font = `400 30px ${MONO}`
    let y = 120
    for (const [text, color] of s.lines ?? []) {
      ctx.fillStyle = color ?? C.text
      ctx.fillText(text, 36, y)
      y += 50
    }
    if (s.status) statusChip(ctx, w - 30, h - 80, s, s.phase ?? 0, 1.25)
  }
  if (s.dim) {
    ctx.fillStyle = `rgba(0,0,0,${s.dim})`
    ctx.fillRect(0, 0, w, h)
  }
}

// Front face of an adapter module in the architecture scene.
export function drawModule(ctx, w, h, s) {
  const color = TOOL_COLOR[s.tool] ?? C.blue
  roundRect(ctx, 8, 8, w - 16, h - 16, 30)
  ctx.fillStyle = s.custom ? 'rgba(251,191,36,0.10)' : 'rgba(12,20,38,0.96)'
  ctx.fill()
  ctx.lineWidth = 5
  ctx.setLineDash(s.custom ? [18, 12] : [])
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.setLineDash([])
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 64px ${MONO}`
  ctx.fillStyle = color
  ctx.fillText(s.custom ? '+' : '>_', w / 2, h * 0.36)
  ctx.font = `800 52px ${SANS}`
  ctx.fillStyle = '#ffffff'
  ctx.fillText(s.label, w / 2, h * 0.68)
  ctx.textAlign = 'left'
}

// The Outpost logo (assets/logo.svg), drawn once it has loaded.
export function drawLogo(ctx, w, h, s) {
  if (s.image) ctx.drawImage(s.image, 0, 0, w, h)
}
