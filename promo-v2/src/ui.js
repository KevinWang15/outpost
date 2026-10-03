// DOM building blocks: headings, cursor, and faithful replicas of the app's UI.
import {
  createElement, Server, Laptop, Monitor, Check, CircleCheck, Search, Bell, Puzzle, SquareTerminal, WifiOff, Unplug,
  ImageOff, ImagePlus, Image, TriangleAlert, ChevronDown, Plus, ArrowRight, Link, X, CornerDownRight, PanelsTopLeft,
  CircleHelp, LoaderCircle, Clock, ShieldCheck, Sparkles, Zap,
} from 'lucide'
import { clamp, easeOut, easeOutBack, prog, style, track } from './util.js'

const ICONS = { Server, Laptop, Monitor, Check, CircleCheck, Search, Bell, Puzzle, SquareTerminal, WifiOff, Unplug, ImageOff, ImagePlus, Image, TriangleAlert, ChevronDown, Plus, ArrowRight, Link, X, CornerDownRight, PanelsTopLeft, CircleHelp, LoaderCircle, Clock, ShieldCheck, Sparkles, Zap }
export function icon(name, size = 24, stroke = 2) {
  const el = createElement(ICONS[name])
  el.setAttribute('width', size)
  el.setAttribute('height', size)
  el.setAttribute('stroke-width', stroke)
  return el.outerHTML
}

export const ASSET = '../assets/'

export const heading = ({ r = 'head', x = 110, y = 96, eyebrow, title, sub = '', width = 760, align = 'left' }) => `
  <div class="head" data-r="${r}" style="left:${x}px;top:${y}px;width:${width}px;text-align:${align}">
    <div class="eyebrow">${eyebrow}</div>
    <h2>${title.replaceAll('\n', '<br>')}</h2>
    ${sub ? `<p>${sub}</p>` : ''}
  </div>`

export const cursorMarkup = (r = 'cursor') => `
  <div class="ripple" data-r="${r}Ripple"></div>
  <svg class="cursor" data-r="${r}" width="46" height="46" viewBox="0 0 24 24"><path d="M4.2 2.6v16.6l4.5-4.2 3 6.6 2.9-1.3-3-6.5 6.3-.2z" fill="#fff" stroke="#0b1220" stroke-width="1.3" stroke-linejoin="round"/></svg>`

// keys: [[t, x, y, opacity]], clicks: [t]
export function driveCursor(r, t, keys, clicks = [], name = 'cursor') {
  const el = r[name]
  const ripple = r[`${name}Ripple`]
  const [x, y, o] = track(keys, t)
  const press = clicks.reduce((m, c) => Math.max(m, 1 - Math.abs(t - c - 0.06) / 0.12), 0)
  style(el, { o, x: x - 6, y: y - 4, s: 1 - 0.16 * clamp(press), origin: '6px 4px' })
  const click = clicks.findLast(c => t >= c && t < c + 0.7)
  if (click === undefined) ripple.style.opacity = 0
  else {
    const p = (t - click) / 0.7
    style(ripple, { o: (1 - p) * 0.95 * o, x: x - 32, y: y - 32, s: 0.25 + easeOut(p) * 1.5 })
  }
}

// Fades a block up from below and (optionally) out again.
export function reveal(el, t, at, { until = Infinity, dur = 0.7, out = 0.45, y = 34, x = 0, s = 1, blur = 8, z = 0, rx = 0 } = {}) {
  const p = easeOut(prog(t, at, dur))
  const q = prog(t, until - out, out)
  style(el, { o: p * (1 - q), x: x * (1 - p), y: y * (1 - p) - q * 16, s: s + (1 - s) * p, blur: blur * (1 - p) + q * 6, z, rx: rx * (1 - p) })
}

export const pop = (t, at, dur = 0.55) => easeOutBack(prog(t, at, dur), 1.9)

// Positions an element centred on a projected world point.
export function pin(el, point, { o = 1, s = 1, dx = 0, dy = 0 } = {}) {
  el.style.opacity = point.behind ? 0 : o
  el.style.visibility = o <= 0.001 ? 'hidden' : 'visible'
  el.style.transform = `translate(${point.x + dx}px, ${point.y + dy}px) translate(-50%, -50%) scale(${s})`
}

export const chip = (r, label, iconName, tone = 'blue') => `<div class="pinchip tone-${tone}" data-r="${r}">${iconName ? icon(iconName, 22, 2.2) : '<i class="dot"></i>'}<span>${label}</span></div>`

/* ---------- App replicas (mirroring the real light theme) ---------- */

export const targetsCard = () => `
  <div class="a-card a-targets" data-r="targets">
    <div class="a-side-head">TARGETS <span>${icon('Plus', 16)}</span></div>
    <div class="a-target" data-r="tAtlas">${icon('Server', 22, 1.8)}<div><b>Atlas development</b><small>atlas.example.com</small></div></div>
    <div class="a-target" data-r="tLab">${icon('Server', 22, 1.8)}<div><b>Research lab</b><small>lab.example.com</small></div></div>
    <div class="a-target" data-r="tLocal">${icon('Monitor', 22, 1.8)}<div><b>This computer</b><small>Local</small></div></div>
    <div class="a-add">${icon('Plus', 16)} Add target</div>
  </div>`

export const createDialog = () => `
  <div class="a-card a-dialog" data-r="dialog">
    <div class="a-eyebrow">OUTPOST / AI SESSION MANAGER</div>
    <div class="a-title">Create a session</div>
    <div class="a-sub">Give your work a home on Atlas development.</div>
    <div class="a-field"><div class="a-label">Session name</div>
      <div class="a-input" data-r="nameField"><span data-r="name"></span><i class="caret" data-r="nameCaret"></i></div></div>
    <div class="a-field"><div class="a-label">Coding tool</div>
      <div class="a-input a-select" data-r="toolField"><span data-r="tool">Codex</span>${icon('ChevronDown', 20)}</div>
      <div class="a-menu" data-r="toolMenu">
        <div class="a-opt">Codex</div><div class="a-opt" data-r="optClaude">Claude</div><div class="a-opt">Kimi</div>
      </div></div>
    <div class="a-field"><div class="a-label">Root directory</div>
      <div class="a-input mono" data-r="dirField"><span data-r="dir"></span><i class="caret" data-r="dirCaret"></i></div>
      <div class="a-menu a-sugg" data-r="sugg">
        <div class="a-opt mono">${icon('CornerDownRight', 18)}/workspaces/demo-dashboard</div>
        <div class="a-opt mono" data-r="suggApi">${icon('CornerDownRight', 18)}/workspaces/demo-api</div>
        <div class="a-opt mono">${icon('CornerDownRight', 18)}/workspaces/demo-client</div>
        <div class="a-hint">Use ↑ / ↓ and Enter to select. Tab completes a single match.</div>
      </div></div>
    <div class="a-actions"><div class="a-btn">Cancel</div><div class="a-btn primary" data-r="createBtn">Create session ${icon('Plus', 18)}</div></div>
  </div>`

export const softwareCard = () => `
  <div class="a-card a-soft" data-r="soft">
    <div class="a-soft-head">
      <div class="a-soft-icon" data-r="softIcon"><span class="warn">${icon('TriangleAlert', 26)}</span><span class="ok">${icon('Check', 26, 2.4)}</span></div>
      <div><b>Required Software</b><small data-r="softSub">1 requirement needs attention</small></div>
    </div>
    <div class="a-soft-row"><span class="ok">${icon('Check', 22, 2.4)}</span><b>Codex</b><small>installed</small></div>
    <div class="a-soft-row" data-r="claudeRow">
      <span class="state" data-r="claudeState"><span class="warn">${icon('TriangleAlert', 22)}</span><span class="ok">${icon('Check', 22, 2.4)}</span></span>
      <b>Claude</b><small data-r="claudeText">Not installed</small>
      <div class="a-btn sm" data-r="installBtn"><span data-r="installLabel">Auto install</span><i class="bar" data-r="installBar"></i></div>
    </div>
    <div class="a-soft-row"><span class="ok">${icon('Check', 22, 2.4)}</span><b>Kimi</b><small>installed</small></div>
    <div class="a-soft-foot">Checked just now <span class="a-btn sm ghost">Configure required software</span></div>
  </div>`

export const terminal = ({ r = 'term', title = 'Build the dashboard', host = 'ATLAS DEVELOPMENT' } = {}) => `
  <div class="term" data-r="${r}">
    <div class="term-bar">${icon('PanelsTopLeft', 20, 1.8)}<span>Codex · ${title}</span><em>${host}</em></div>
    <div class="term-body">
      <div class="term-banner"><b>›_ OpenAI Codex</b><div><span>project:</span> <i>demo-dashboard</i></div><div><span>directory:</span> /workspaces/demo-dashboard</div></div>
      <div class="term-lines" data-r="${r}Lines"></div>
      <div class="term-prompt" data-r="${r}Prompt">
        <div class="term-attach" data-r="${r}Attach"><b>[Image]</b> dashboard-concept.png</div>
        <div class="term-input">› <span data-r="${r}Input"></span><i class="caret block" data-r="${r}Caret"></i></div>
      </div>
      <div class="term-foot">Codex · ${title} · Connected</div>
    </div>
  </div>`

export const attachModal = () => `
  <div class="a-card a-attach" data-r="attach">
    <div class="a-eyebrow">OUTPOST / AI SESSION MANAGER</div>
    <div class="a-title">Attach an image to Build the dashboard</div>
    <div class="a-sub">Paste, drop, or browse for an image to share with your coding session.</div>
    <div class="a-drop" data-r="drop">
      <div class="a-drop-empty" data-r="dropEmpty">${icon('ImagePlus', 44, 1.6)}<span>Paste or drop an image</span></div>
      <img data-r="dropImg" src="${ASSET}dashboard-concept.png">
    </div>
    <div class="a-actions split"><div class="a-btn">Browse images</div><span></span><div class="a-btn">Cancel</div><div class="a-btn primary" data-r="sendBtn">${icon('ImagePlus', 20)} Send to session</div></div>
  </div>`

export const finderCard = () => `
  <div class="a-card a-finder" data-r="finder">
    <div class="a-eyebrow">OUTPOST / AI SESSION MANAGER</div>
    <div class="a-title">Find coding sessions</div>
    <div class="a-sub">Search conversations across Atlas development, including sessions created outside the manager.</div>
    <div class="a-row">
      <div class="a-field grow"><div class="a-label">Conversation keyword</div><div class="a-input" data-r="kwField"><span data-r="kw"></span><i class="caret" data-r="kwCaret"></i></div></div>
      <div class="a-field"><div class="a-label">Coding tool</div><div class="a-input a-select">All coding tools ${icon('ChevronDown', 18)}</div></div>
      <div class="a-btn primary tall" data-r="searchBtn">${icon('Search', 20)} Search</div>
    </div>
    <div class="a-note">Search runs on the target. Conversation files stay there; results are never saved by the manager.</div>
    <div class="a-count" data-r="count">2 matching conversations</div>
    <div class="a-result" data-r="res1">
      <div class="a-res-head"><span class="tag">Codex</span><b>Design resilient API requests</b><span class="tag">Managed</span><div class="a-btn sm" data-r="res1Btn">${icon('ArrowRight', 18)} Connect</div></div>
      <div class="mono path">/workspaces/demo-dashboard</div>
      <div class="a-snippet">Add a short backoff before <mark>retry</mark>ing transient network failures. Keep the <mark>retry</mark> policy easy to test.</div>
    </div>
    <div class="a-result" data-r="res2">
      <div class="a-res-head"><span class="tag">Claude</span><b>Review the <mark>retry</mark> policy</b><div class="a-btn sm">${icon('Link', 18)} Link session</div></div>
      <div class="mono path">/workspaces/demo-api</div>
      <div class="a-snippet">Use a bounded <mark>retry</mark> strategy and show a clear message when the request still cannot complete.</div>
    </div>
  </div>`
