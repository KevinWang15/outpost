// Scene choreography. Each scene builds its DOM once and exposes
// update(t, w), where t is seconds since the scene started and w is the 3D world.
// Every timing comes from `cue` — the measured moment a phrase is spoken.
import * as THREE from 'three'
import { C } from './textures.js'
import { clamp, easeIn, easeInOut, easeOut, easeOutBack, lerp, prog, springy, style, track, typed, win } from './util.js'
import {
  ASSET, attachModal, chip, createDialog, cursorMarkup, driveCursor, finderCard, heading, icon, pin, pop, reveal, softwareCard, targetsCard, terminal,
} from './ui.js'

const V = (x, y, z) => new THREE.Vector3(x, y, z)
const TOOLS = ['Codex', 'Claude Code', 'Kimi']
const WORK = {
  Codex: [['› Build the dashboard interface', '#ffffff'], ['• Preparing summary cards'], ['• Adding a progress chart'], ['• Checking mobile spacing', C.cyan]],
  'Claude Code': [['› Review the API changes', '#ffffff'], ['• Reading 12 changed files'], ['• Retry policy looks good'], ['• Suggesting two small fixes', '#f6a26b']],
  Kimi: [['› Explore the next idea', '#ffffff'], ['• Sketching three options'], ['• Comparing trade-offs'], ['• Drafting a prototype', C.mint]],
}
const TITLES = { Codex: 'Build the dashboard', 'Claude Code': 'Review the API', Kimi: 'Explore the next idea' }
// Session layout per server: which tools run where.
const LAYOUT = [['Codex', 'Claude Code'], ['Kimi', 'Codex', 'Claude Code'], ['Claude Code', 'Kimi']]

function panelState(tool, t, { status = 'working', typedFrom = -10, cps = 26, alert, question, highlight } = {}) {
  return { tool, title: TITLES[tool], lines: WORK[tool], typed: Math.floor((t - typedFrom) * cps), status, phase: t * 5, cursor: true, alert, question, highlight }
}

// Places the panels of a server in an arc above the tower.
function panelSlot(server, j, count, t, { radius = 2.7, height = 4.6, bob = 0.12 } = {}) {
  const spread = count === 1 ? 0 : (j / (count - 1) - 0.5) * 2.1
  const p = server.group.position
  return V(p.x + Math.sin(spread * 0.55) * radius * 0.95, p.y + height + Math.cos(spread * 1.1) * 0.55 + Math.sin(t * 1.3 + j * 2 + p.x) * bob, p.z + Math.cos(spread * 0.55) * 0.9 - 0.4)
}

function placePanels(w, t, appear, opts = {}) {
  w.servers.forEach((server, i) => {
    const tools = LAYOUT[i]
    tools.forEach((tool, j) => {
      const panel = server.panels[j]
      const at = appear(i, j)
      const p = clamp((t - at) / 0.7)
      if (p <= 0) return
      const slot = panelSlot(server, j, tools.length, t, opts)
      panel.group.position.copy(slot)
      panel.group.position.y -= (1 - easeOut(p)) * 1.4
      panel.group.lookAt(w.camera.position.x * 0.6 + slot.x * 0.4, slot.y - 0.5, w.camera.position.z)
      const state = typeof opts.state === 'function' ? opts.state(i, j, tool) : {}
      panel.show(panelState(tool, t, { typedFrom: at + 0.2, ...state }), { opacity: easeOut(p) * (opts.opacity ?? 1), scale: (0.6 + 0.4 * easeOutBack(p)) * (opts.scale ?? 0.95), glow: state.glow ?? 0.3, glowColor: state.glowColor })
    })
  })
}

function showServers(w, t, { from = 0, stagger = 0.3, rise = 0.9, only, alert = [] } = {}) {
  w.servers.forEach((server, i) => {
    if (only && !only.includes(i)) return
    const p = clamp((t - from - i * stagger) / rise)
    if (p <= 0) return
    server.group.visible = true
    server.group.position.y = server.home.y - (1 - easeOut(p)) * 4
    server.group.scale.setScalar(0.4 + 0.6 * easeOutBack(p, 1.2))
    w.animateServer(server, t, { alert: alert.includes(i) && Math.floor(t * 4) % 2 === 0 })
  })
}

const hostChip = i => `<div class="host" data-r="host${i}"><b>${['atlas', 'lab', 'gpu'][i]}</b>.example.com</div>`

/* 1 · HOOK — agents are part of coding; work runs on several dev servers. */
function hook(cue) {
  return {
    chapter: 'AI coding today',
    markup: `
      <div class="kinetic" data-r="k1" style="top:300px">AI agents have become<br>part of how we <em>code.</em></div>
      ${[0, 1, 2].map(hostChip).join('')}
      ${TOOLS.map((tool, i) => chip(`tool${i}`, tool, 'SquareTerminal', ['cyan', 'amber', 'mint'][i])).join('')}
      <div class="badges" data-r="verbs" style="left:0;right:0;top:880px;justify-content:center">
        <div class="badge" data-r="v0">${icon('Zap', 24)}Build features</div><div class="badge" data-r="v1">${icon('Search', 24)}Review changes</div><div class="badge" data-r="v2">${icon('Sparkles', 24)}Explore ideas</div>
      </div>
      ${heading({ r: 'head', x: 110, y: 120, eyebrow: 'Where the work runs', title: 'On remote dev servers.\n<em>Usually, more than one.</em>', width: 900 })}`,
    update(t, w, r) {
      // Camera: start close on a lone glowing terminal, pull back to reveal the servers.
      const cam = track([[0, 0, 4.4, 6.6], [4, 0, 4.6, 8.6], [9.5, 0.5, 5.4, 15], [12, 0, 8.5, 24], [16.5, 1.5, 9, 25.5]], t)
      const look = track([[0, 0, 4.2, 0], [9.5, 0, 4.0, 0], [12, 0, 4.3, 0], [16.5, 0, 4.3, 0]], t)
      w.setCamera(cam, look, 34)
      w.renderer.toneMappingExposure = 0.2 + 0.85 * easeOut(prog(t, 0, 1.6))
      reveal(r.k1, t, 0.15, { until: cue.tools - 0.2, dur: 0.9, y: 40 })
      // The three tools appear as floating terminals in the middle.
      const center = w.servers[1]
      center.group.visible = false
      TOOLS.forEach((tool, j) => {
        const at = [cue.tools, cue.claude, cue.kimi][j] - 0.15
        const p = clamp((t - at) / 0.7)
        const panel = center.panels[j]
        if (p <= 0) return
        // While alone, the tool terminals hover in front of the camera; at "servers" they settle onto towers.
        const settle = easeInOut(prog(t, cue.servers - 0.6, 1.8))
        const free = V((j - 1) * 2.9, 4.3 + Math.sin(t * 1.2 + j) * 0.08, 0.6 - Math.abs(j - 1) * 0.5)
        const target = panelSlot(w.servers[j], 0, 1, t, { height: 4.9 })
        const pos = free.clone().lerp(target, settle)
        panel.group.position.copy(pos)
        panel.group.position.y -= (1 - easeOut(p)) * 0.8
        panel.group.lookAt(w.camera.position.x * 0.5, pos.y - 0.3, w.camera.position.z)
        const verb = [cue.build, cue.review, cue.explore][j]
        panel.show(panelState(tool, t, { typedFrom: at + 0.3, highlight: t > verb && t < verb + 1.1 }), { opacity: easeOut(p), scale: (0.55 + 0.45 * easeOutBack(p)) * 0.95, glow: 0.35 + (t > verb && t < verb + 1.1 ? 0.35 : 0) })
        pin(r[`tool${j}`], w.project(pos.clone().add(V(0, 1.15, 0))), { o: easeOut(p) * (1 - prog(t, cue.servers - 0.4, 0.4)), s: 0.8 + 0.2 * pop(t, at) })
      })
      ;[0, 1, 2].forEach(j => reveal(r[`v${j}`], t, [cue.build, cue.review, cue.explore][j] - 0.1, { until: cue.servers, dur: 0.5, y: 24 }))
      // Servers rise under the terminals, then the extra sessions multiply.
      showServers(w, t, { from: cue.servers - 0.5, stagger: 0.25 })
      w.servers.forEach((server, i) => {
        if (!server.group.visible) return
        pin(r[`host${i}`], w.project(server.group.position.clone().add(V(0, -0.4, 1.2))), { o: easeOut(prog(t, cue.servers + 0.4 + i * 0.2, 0.5)) })
        const extra = LAYOUT[i].length
        for (let j = 1; j < extra; j++) {
          const at = cue.many + 0.1 + (i * 2 + j) * 0.18
          const p = clamp((t - at) / 0.6)
          if (p <= 0) continue
          const tool = LAYOUT[i][j]
          const slot = panelSlot(server, j, extra, t, { height: 4.9 })
          const panel = server === center ? center.panels[j] : server.panels[j]
          if (server === center && j < 3) continue
          panel.group.position.copy(slot)
          panel.group.lookAt(w.camera.position.x * 0.5, slot.y - 0.3, w.camera.position.z)
          panel.show(panelState(tool, t, { typedFrom: at }), { opacity: easeOut(p), scale: (0.5 + 0.5 * easeOutBack(p)) * 0.9 })
        }
      })
      reveal(r.head, t, cue.servers + 0.2, { dur: 0.8 })
      w.floor.material.uniforms.uPulseOrigin.value.set(0, 0)
      w.floor.material.uniforms.uPulse.value = t > cue.servers - 0.3 ? clamp((t - cue.servers + 0.3) / 2.6) : 0
    },
  }
}

/* 2 · FRICTION — SSH drops, no image paste, scattered sessions. */
function friction(cue) {
  const items = [
    ['Unplug', 'The connection drops', 'and the agent can stop with it.'],
    ['ImageOff', "Screenshots don't paste", 'into a remote terminal.'],
    ['CircleHelp', "What's running where?", 'Sessions spread across servers.'],
  ]
  return {
    chapter: 'The rough edges',
    markup: `
      ${heading({ x: 110, y: 120, eyebrow: 'Working over SSH', title: 'A few rough edges.', width: 700 })}
      <div class="list" data-r="list" style="left:110px;top:360px;width:640px">
        ${items.map(([ic, a, b], i) => `<div class="item" data-r="i${i}"><span class="num">${icon(ic, 28)}</span><div>${a}<small>${b}</small></div></div>`).join('')}
      </div>
      ${chip('lost', 'Connection lost', 'WifiOff', 'red')}
      ${chip('stopped', 'Agent stopped', 'TriangleAlert', 'red')}
      <img class="flyimg" data-r="img" src="${ASSET}dashboard-concept.png">
      <div class="keycap" data-r="keys" style="left:0;top:0"><span>Ctrl</span><span>V</span></div>
      ${chip('nope', 'Image paste not supported', 'ImageOff', 'red')}
      ${[0, 1, 2].map(hostChip).join('')}`,
    update(t, w, r) {
      // Act 1: laptop + one server connected by an SSH beam that snaps.
      const act = t < cue.paste - 0.35 ? 1 : t < cue.scatter - 0.3 ? 2 : 3
      const cam = track([[0, 6.6, 4.8, 15], [cue.paste - 0.4, 6.2, 4.4, 14], [cue.paste, 4.6, 3.6, 11.5], [cue.scatter - 0.35, 4.6, 3.4, 11.2], [cue.scatter, 3.4, 8, 24], [18.5, 3, 8.4, 25.5]], t)
      const look = track([[0, 5.2, 2.6, 0.5], [cue.paste - 0.4, 5.2, 2.6, 0.5], [cue.paste, 3.4, 1.9, 2.5], [cue.scatter - 0.35, 3.4, 1.9, 2.5], [cue.scatter, 3.6, 3.6, 0], [18.5, 3.6, 3.6, 0]], t)
      w.setCamera(cam, look, 34, 0.16 * easeInOut(prog(t, cue.scatter - 0.35, 0.8)))
      w.renderer.toneMappingExposure = 1.05
      reveal(r.head, t, 0.2, { dur: 0.8 })
      reveal(r.list, t, 0.5, { dur: 0.8, x: -30, y: 0 })
      const on = [cue.drop, cue.paste, cue.scatter]
      on.forEach((at, i) => r[`i${i}`].classList.toggle('on', t >= at - 0.1 && (i === 2 || t < on[i + 1] - 0.1)))
      on.forEach((at, i) => { r[`i${i}`].style.opacity = t < at - 0.1 ? 0.45 : 1 })

      const laptop = w.devices.laptop
      const server = w.servers[0]
      const lp = V(4.4, 0, 4.2)
      laptop.group.visible = act < 3
      laptop.group.position.copy(lp)
      laptop.group.rotation.y = 0.5
      laptop.hinge.rotation.x = -0.24
      laptop.screen.update({ mode: 'terminal', lines: [['$ ssh atlas.example.com', C.dim], ['› Build the dashboard', '#fff'], ['• Preparing summary cards'], t > cue.drop ? ['Connection closed.', C.red] : ['• Adding a progress chart']], status: t > cue.stop ? 'stopped' : 'working', phase: t * 5, dim: act === 2 ? 0.25 : 0 })
      server.group.visible = act < 3 || true
      server.group.position.set(act < 3 ? 9.6 : server.home.x, 0, act < 3 ? -1 : 0)
      server.group.scale.setScalar(1)
      w.animateServer(server, t, { alert: act === 1 && t > cue.stop })
      if (act === 1) {
        const snap = t > cue.drop
        w.beams[0].show({ a: lp.clone().add(V(0, 1.8, -0.6)), b: server.group.position.clone().add(V(0, 3, 0.4)), lift: 2.2, draw: easeOut(prog(t, 0.3, 1.2)), gap: snap ? [0.5 - 0.3 * easeOut(prog(t, cue.drop, 0.6)), 0.5 + 0.3 * easeOut(prog(t, cue.drop, 0.6))] : null, color: snap ? C.red : C.cyan, pulse: snap ? null : t * 0.6, opacity: 1 - 0.6 * prog(t, cue.drop + 0.8, 1) })
        if (snap) w.sparks.add({ origin: lp.clone().add(V(0, 1.8, -0.6)).lerp(server.group.position.clone().add(V(0, 3, 0.4)), 0.5).add(V(0, 2.2 * 0.5, 0)), age: t - cue.drop, seed: 11, count: 160, speed: 4, hex: C.red })
        const panel = server.panels[0]
        const slot = panelSlot(server, 0, 1, t, { height: 4.7 })
        panel.group.position.copy(slot)
        panel.group.lookAt(w.camera.position)
        const stopped = t > cue.stop
        panel.show(panelState('Codex', t, { typedFrom: -5, status: stopped ? 'stopped' : 'working', alert: stopped ? 'Session ended' : undefined }), { opacity: 1, scale: 0.9, glow: stopped ? 0.55 : 0.3, glowColor: stopped ? '#e11d48' : '#3b82f6' })
      }
      const mid = w.project(V(7, 4.6, 1.6))
      pin(r.lost, mid, { o: act === 1 ? pop(t, cue.drop + 0.1) : 0, s: 0.6 + 0.4 * pop(t, cue.drop + 0.1), dy: -40 })
      pin(r.stopped, w.project(V(9.6, 6.6, -1)), { o: act === 1 ? pop(t, cue.stop) : 0, s: 0.6 + 0.4 * pop(t, cue.stop) })

      // Act 2: an image flies toward the remote terminal and bounces off.
      const p2 = prog(t, cue.paste - 0.2, 2.2)
      const screen = w.project(lp.clone().add(V(-0.3, 1.2, -1.1)))
      if (act === 2) {
        const fly = easeInOut(clamp(p2 / 0.55))
        const bounce = clamp((p2 - 0.55) / 0.45)
        const x = lerp(1500, screen.x - 180, fly) + bounce * 260
        const y = lerp(340, screen.y - 140, fly) - Math.sin(bounce * Math.PI) * 120 + bounce * 30
        style(r.img, { o: (1 - bounce * 0.4) * clamp(p2 * 6), x, y, s: lerp(1, 0.55, fly), r: bounce * 14 })
        r.img.style.filter = bounce > 0 ? `grayscale(${bounce}) brightness(${1 - bounce * 0.3})` : 'none'
        pin(r.keys, { x: screen.x + 330, y: screen.y + 60 }, { o: win(t, cue.paste + 0.2, cue.scatter - 0.4, 0.3, 0.3), s: 0.9 + 0.1 * pop(t, cue.paste + 0.2) })
        pin(r.nope, { x: screen.x + 60, y: screen.y - 250 }, { o: pop(t, cue.paste + 1.25) * (1 - prog(t, cue.scatter - 0.6, 0.3)), s: 0.7 + 0.3 * pop(t, cue.paste + 1.25) })
      } else { r.img.style.opacity = 0; r.keys.style.opacity = 0; r.nope.style.opacity = 0 }

      // Act 3: sessions scattered across three servers, all fogged with "?".
      if (act === 3) {
        showServers(w, t, { from: cue.scatter - 0.3, stagger: 0.12, rise: 0.5 })
        placePanels(w, t, (i, j) => cue.scatter - 0.1 + (i * 3 + j) * 0.1, { state: (i, j) => ({ question: t > cue.where - 0.4 + (i + j) * 0.07, status: 'unknown', statusLabel: '?' }) })
        w.servers.forEach((server, i) => pin(r[`host${i}`], w.project(server.group.position.clone().add(V(0, -0.4, 1.2))), { o: easeOut(prog(t, cue.scatter + 0.3 + i * 0.1, 0.4)) }))
      } else [0, 1, 2].forEach(i => { r[`host${i}`].style.opacity = 0 })
    },
  }
}

/* 3 · REVEAL — the product; agents stay on servers; laptop and desktop see everything. */
function reveal3(cue) {
  return {
    chapter: 'One place for every session',
    markup: `
      <div class="brand" data-r="brand" style="top:690px"><div class="name">Outpost</div><div class="tag2">AI Session Manager</div></div>
      ${[0, 1, 2].map(hostChip).join('')}
      ${chip('lap', 'Laptop', 'Laptop', 'blue')}${chip('desk', 'Desktop', 'Monitor', 'blue')}
      ${heading({ x: 110, y: 110, eyebrow: 'The idea', title: 'Agents stay on your servers.\n<em>You see them all in one place.</em>', width: 1100 })}`,
    update(t, w, r) {
      // Logo bloom, then dolly back to a wide shot with devices in the foreground.
      const cam = track([[0, 0, 4.0, 13], [3.2, 0, 4.2, 14], [6.5, 0, 9.5, 27], [14.7, 1.2, 10, 28.5]], t)
      const look = track([[0, 0, 4.0, 0], [3.2, 0, 4.2, 0], [6.5, 0, 3.2, 2.5], [14.7, 0, 3.2, 2.5]], t)
      w.setCamera(cam, look, 34)
      const logoIn = easeOutBack(prog(t, cue.product - 0.2, 0.9), 1.4)
      const logoOut = easeInOut(prog(t, cue.run - 0.3, 0.9))
      w.logo.visible = logoOut < 1
      w.logo.position.set(0, 5.0 + logoOut * 2.4, 0)
      w.logo.scale.setScalar(Math.max(0.001, logoIn * (1 - logoOut)))
      w.logo.rotation.y = (1 - easeOut(prog(t, cue.product - 0.2, 1.2))) * Math.PI * 1.2
      w.logo.lookAt(w.camera.position)
      w.ring.scale.setScalar(1 + prog(t, cue.product, 1.4) * 2.6)
      w.ring.material.opacity = (1 - prog(t, cue.product, 1.4)) * 0.9
      w.logoGlow.material.opacity = 0.8 * (1 - logoOut)
      w.renderer.toneMappingExposure = 1.05 + 0.5 * Math.exp(-((t - cue.product - 0.3) ** 2) * 6)
      reveal(r.brand, t, cue.product + 0.2, { until: cue.run - 0.1, dur: 0.6 })

      showServers(w, t, { from: cue.run - 0.2, stagger: 0.15 })
      placePanels(w, t, (i, j) => cue.run + 0.3 + (i * 3 + j) * 0.12)
      w.servers.forEach((server, i) => pin(r[`host${i}`], w.project(server.group.position.clone().add(V(0, -0.4, 1.2))), { o: easeOut(prog(t, cue.run + 0.6 + i * 0.1, 0.5)) }))

      const { laptop, desktop } = w.devices
      const lp = V(-5, 0, 7.5)
      const dp = V(5.2, 0, 7)
      const li = easeOutBack(prog(t, cue.laptop - 0.2, 0.9), 1.2)
      const di = easeOutBack(prog(t, cue.desktop - 0.2, 0.9), 1.2)
      laptop.group.visible = li > 0
      laptop.group.position.set(lp.x, (1 - li) * -2, lp.z)
      laptop.group.rotation.y = 0.3
      laptop.group.scale.setScalar(Math.max(0.001, li))
      laptop.hinge.rotation.x = lerp(1.53, -0.24, easeOut(prog(t, cue.laptop, 1.0)))
      desktop.group.visible = di > 0
      desktop.group.position.set(dp.x, (1 - di) * -2, dp.z)
      desktop.group.rotation.y = -0.3
      desktop.group.scale.setScalar(Math.max(0.001, di * 0.9))
      const dash = { mode: 'dashboard', image: window.FILM_IMAGES.dashboard }
      laptop.screen.update(dash)
      desktop.screen.update(dash)
      pin(r.lap, w.project(lp.clone().add(V(-2.4, 0.4, 0.6))), { o: easeOut(prog(t, cue.laptop + 0.3, 0.4)) })
      pin(r.desk, w.project(dp.clone().add(V(2.9, 0.6, 0.4))), { o: easeOut(prog(t, cue.desktop + 0.3, 0.4)) })
      // Beams from each device to each server.
      let k = 0
      for (const [device, at, from] of [[laptop, cue.every, lp], [desktop, cue.every + 0.35, dp]]) {
        w.servers.forEach((server, i) => {
          const start = at + i * 0.18
          w.beams[k++].show({ a: from.clone().add(device === laptop ? V(0, 2.1, -1.1) : V(0, 3.6, -0.1)), b: server.group.position.clone().add(V(0, 3.4, 0.3)), lift: 3.5, draw: easeInOut(prog(t, start, 1.1)), pulse: t * 0.45 + i * 0.2, opacity: prog(t, start, 0.2) * 0.85, color: device === laptop ? C.cyan : '#7cc4ff' })
        })
      }
      reveal(r.head, t, cue.every - 0.6, { dur: 0.8 })
      w.floor.material.uniforms.uPulseOrigin.value.set(0, 0)
      w.floor.material.uniforms.uPulse.value = t > cue.product ? clamp((t - cue.product) / 2.4) : 0
    },
  }
}

/* 4 · CREATE — server, name, agent, folder, auto-install. */
function create(cue) {
  const steps = ['Pick a server', 'Name the session', 'Choose your agent', 'Choose a project folder', 'Install the agent if needed']
  return {
    chapter: 'Start a session',
    markup: `
      ${heading({ x: 110, y: 110, eyebrow: 'Start a session', title: 'Ready in a\n<em>few clicks.</em>', width: 600 })}
      <div class="list steps" data-r="steps" style="left:110px;top:430px;width:520px">
        ${steps.map((s, i) => `<div class="item" data-r="s${i}"><span class="num">${i + 1}</span>${s}</div>`).join('')}
      </div>
      ${targetsCard()}
      ${createDialog()}
      ${softwareCard()}
      ${cursorMarkup()}`,
    update(t, w, r) {
      w.setCamera(track([[0, 6, 6, 18], [17.5, 9, 6.5, 20]], t), [0, 3, 0], 34)
      showServers(w, t, { from: -2 })
      placePanels(w, t, () => -2, { opacity: 0.85 })
      w.renderer.toneMappingExposure = 0.75
      reveal(r.head, t, 0.1)
      reveal(r.steps, t, 0.3, { x: -30, y: 0 })
      const marks = [cue.server, cue.name, cue.agent, cue.folder, cue.missing]
      marks.forEach((at, i) => {
        r[`s${i}`].classList.toggle('cur', t >= at - 0.1 && t < (marks[i + 1] ?? cue.install + 1.2) - 0.1)
        r[`s${i}`].classList.toggle('done', t >= (marks[i + 1] ?? cue.install + 1.2) - 0.1)
        r[`s${i}`].style.opacity = t >= at - 0.1 ? 1 : 0.4
      })
      // Card positions: target list → dialog → software panel.
      const softIn = cue.missing - 0.5
      const tilt = easeOut(prog(t, 0.2, 1))
      style(r.targets, { o: easeOut(prog(t, 0.4, 0.6)) * (1 - prog(t, cue.name - 0.4, 0.4)), x: 860, y: 270 + (1 - tilt) * 40, ry: -14 * (1 - tilt) - 4, s: 1.12 })
      r.tAtlas.classList.toggle('sel', t > cue.server + 0.45)
      const dIn = easeOutBack(prog(t, cue.name - 0.5, 0.7), 1.2)
      const dOut = easeInOut(prog(t, softIn, 0.6))
      style(r.dialog, { o: clamp(dIn * 1.4) * (1 - dOut), x: 900 + dOut * -120, y: 150 + (1 - dIn) * 60, s: (0.92 + 0.08 * dIn) * (1 - 0.1 * dOut), ry: -6, rx: dOut * 10 })
      const sIn = easeOutBack(prog(t, softIn + 0.1, 0.7), 1.1)
      style(r.soft, { o: clamp(sIn * 1.4), x: 770, y: 330 + (1 - sIn) * 80, s: 0.94 + 0.06 * sIn, ry: -5 })
      // Typing.
      const nameText = typed('Build a new feature', t, cue.name + 0.4, 22)
      r.name.textContent = nameText
      r.nameField.classList.toggle('focus', t > cue.name && t < cue.agent)
      r.nameCaret.style.opacity = t > cue.name && t < cue.agent && Math.floor(t * 2.4) % 2 === 0 ? 1 : 0
      const menu = t > cue.agent + 0.35 && t < cue.agent + 1.4
      r.toolMenu.style.display = menu ? 'block' : 'none'
      r.optClaude.classList.toggle('hot', t > cue.agent + 0.85)
      r.tool.textContent = t > cue.agent + 1.4 ? 'Claude' : 'Codex'
      r.toolField.classList.toggle('focus', menu)
      r.dir.textContent = typed('/workspaces/demo-', t, cue.folder + 0.2, 20) + (t > cue.folder + 2.3 ? 'api' : '')
      r.dirField.classList.toggle('focus', t > cue.folder && t < softIn)
      r.dirCaret.style.opacity = t > cue.folder && t < softIn && Math.floor(t * 2.4) % 2 === 0 ? 1 : 0
      r.sugg.style.display = t > cue.folder + 1.0 && t < cue.folder + 2.3 ? 'block' : 'none'
      r.suggApi.classList.toggle('hot', t > cue.folder + 1.6)
      // Install progress.
      const installStart = cue.install - 0.4
      const ip = clamp((t - installStart) / 1.6)
      const done = ip >= 1
      r.installBtn.classList.toggle('press', t > installStart - 0.05 && t < installStart + 0.15)
      r.installLabel.textContent = done ? 'Installed' : ip > 0 ? 'Installing…' : 'Auto install'
      r.installBar.style.width = `${ip * 100}%`
      r.claudeText.textContent = done ? 'installed · ready' : 'Not installed'
      r.claudeState.querySelector('.warn').style.opacity = done ? 0 : 1
      r.claudeState.querySelector('.ok').style.opacity = done ? 1 : 0
      r.softIcon.querySelector('.warn').style.opacity = done ? 0 : 1
      r.softIcon.querySelector('.ok').style.opacity = done ? 1 : 0
      r.softIcon.style.background = done ? '#ecfdf5' : '#fffbeb'
      r.softSub.textContent = done ? 'All good · required software is installed' : '1 requirement needs attention'
      r.soft.style.borderColor = done ? '#a7f3d0' : '#fcd34d'
      if (done) w.sparks.add({ origin: V(3.5, 3.5, 6), age: t - installStart - 1.6, seed: 5, count: 90, speed: 3, hex: C.mint })
      // Cursor path through the interaction.
      driveCursor(r, t, [
        [0, 1500, 900, 0], [cue.server - 0.6, 1300, 700, 1], [cue.server + 0.3, 1090, 390, 1], [cue.name, 1100, 420, 1],
        [cue.agent + 0.2, 1200, 520, 1], [cue.agent + 0.7, 1240, 640, 1], [cue.folder - 0.2, 1460, 760, 1], [cue.folder + 1.5, 1300, 760, 1], [cue.folder + 2.1, 1290, 740, 1],
        [cue.install - 1, 1500, 760, 1], [installStart - 0.05, 1640, 586, 1], [installStart + 2.4, 1680, 640, 1], [17.5, 1700, 700, 0],
      ], [cue.server + 0.35, cue.agent + 0.3, cue.agent + 1.3, cue.folder + 2.2, installStart])
    },
  }
}

/* 5 · CONNECT — Click Connect → terminal on your computer, attached to the server session. */
function connect(cue) {
  return {
    chapter: 'Connect',
    markup: `
      <div class="shot" data-r="dash" style="left:0;top:0;width:1264px;height:505px"><img src="${ASSET}screenshots/dashboard-focus.png" width="1264" height="505"></div>
      ${terminal({ r: 'term' })}
      ${heading({ x: 110, y: 110, eyebrow: 'Connect', title: 'One click.\n<em>You\'re in.</em>', sub: 'A terminal opens on your computer, already attached to the session on the server.', width: 620 })}
      <div class="badges" data-r="rd" style="left:110px;top:780px;flex-direction:column;align-items:flex-start">
        <div class="badge" data-r="b0">${icon('Monitor', 24)}Like remote desktop</div>
        <div class="badge" data-r="b1">${icon('SquareTerminal', 24)}Built for coding</div>
        <div class="badge strike" data-r="b2">${icon('X', 24)}<span>No server desktop needed</span></div>
      </div>
      ${cursorMarkup()}`,
    update(t, w, r) {
      // 3D backdrop: camera pushes in toward Atlas, a beam links it to the viewer.
      w.setCamera(track([[0, 2, 6, 20], [cue.terminal + 0.5, -2, 5, 12], [17, -3.5, 5, 11]], t), track([[0, 0, 3.5, 0], [cue.terminal + 0.5, -4, 4, 0], [17, -5, 4, 0]], t), 36)
      showServers(w, t, { from: -2 })
      placePanels(w, t, () => -2, { opacity: 0.9 })
      w.renderer.toneMappingExposure = 0.7
      // Dashboard screenshot zooms toward the Connect button, then the terminal launches out of it.
      const btn = { x: 0.8913 * 1264, y: 0.3518 * 505 }
      const zoom = easeInOut(prog(t, 0, cue.click + 0.2))
      const launch = easeInOut(prog(t, cue.terminal - 0.25, 0.9))
      const ds = lerp(1.15, 1.6, zoom) * (1 + launch * 0.4)
      const dx = lerp(560, 960 - btn.x * 1.6, zoom)
      const dy = lerp(300, 540 - btn.y * 1.6, zoom)
      style(r.dash, { o: 1 - launch, x: dx - (ds - 1) * 632 + (ds - 1) * 632, y: dy, s: ds, origin: '0 0', blur: launch * 10 })
      const term = easeOutBack(prog(t, cue.terminal - 0.1, 0.9), 1.1)
      style(r.term, { o: clamp(term * 1.5), x: lerp(dx + btn.x * ds - 500, 790, term), y: lerp(dy + btn.y * ds - 330, 210, term), s: lerp(0.1, 1, term), ry: -8 * term, rx: 4 * (1 - term) })
      const lines = [
        ['› Build the dashboard interface.', 'u'], ['• Preparing summary cards and a progress chart.', ''], ['• Checking responsive layout and mobile spacing.', ''], ['The coding session is still running.', 'c'],
      ]
      r.termLines.innerHTML = lines.map(([text, cls], i) => `<div class="${cls}">${typed(text, t, cue.terminal + 0.6 + i * 0.75, 48)}</div>`).join('') +
        (t > cue.see ? `<div class="s">${icon('LoaderCircle', 18)} Working · refining the interface</div>` : '')
      r.termAttach.style.display = 'none'
      r.termInput.textContent = typed('Also add a dark mode toggle', t, cue.pickup + 0.3, 16)
      r.termCaret.style.opacity = Math.floor(t * 2.2) % 2 === 0 ? 1 : 0
      reveal(r.head, t, cue.terminal + 0.6, { dur: 0.8 })
      reveal(r.b0, t, cue.remote - 0.1, { x: -24, y: 0 })
      reveal(r.b1, t, cue.built - 0.1, { x: -24, y: 0 })
      reveal(r.b2, t, cue.nodesk - 0.1, { x: -24, y: 0 })
      r.rd.style.opacity = 1
      r.rd.style.visibility = 'visible'
      driveCursor(r, t, [[0, 1500, 820, 0], [cue.click - 0.5, 1160, 640, 1], [cue.click + 0.05, 960, 540, 1], [cue.terminal, 960, 540, 1], [cue.terminal + 0.3, 1000, 600, 0]], [cue.click + 0.05])
    },
  }
}

/* 6 · PERSIST — close the laptop, agent keeps working; reconnect from another computer. */
function persist(cue) {
  return {
    chapter: 'Keeps running',
    markup: `
      ${heading({ x: 110, y: 110, eyebrow: 'Persistent sessions', title: 'Your connection is\njust a <em>window.</em>', width: 820 })}
      ${chip('closed', 'Laptop closed · Wi-Fi off', 'WifiOff', 'dim')}
      ${chip('keeps', 'Agent keeps working', 'LoaderCircle', 'cyan')}
      ${chip('later', '2 hours later', 'Clock', 'blue')}
      ${chip('back', 'Right where you left off', 'CircleCheck', 'mint')}
      ${hostChip(0)}`,
    update(t, w, r) {
      const server = w.servers[0]
      server.group.visible = true
      server.group.position.set(0, 0, -1.5)
      w.animateServer(server, t, { intensity: 1.2 })
      const { laptop, desktop } = w.devices
      const lp = V(-5.2, 0, 2.6)
      const dp = V(5.6, 0, 2.2)
      const cam = track([[0, -1.5, 6.4, 20], [cue.close + 0.4, -2.6, 5.8, 18], [cue.later, -0.6, 6.4, 20.5], [cue.different + 0.5, 2, 6, 19], [18, 2.4, 6, 18.5]], t)
      w.setCamera(cam, track([[0, 0.6, 3.3, 0], [cue.close + 0.4, -1.4, 3.1, 0.4], [cue.later, 0.6, 3.3, 0], [cue.different + 0.5, 2.2, 3.2, 0], [18, 2.4, 3.2, 0]], t), 36)
      w.renderer.toneMappingExposure = 1.05 - 0.25 * win(t, cue.later - 0.5, cue.later + 1.6, 0.4, 0.6)
      laptop.group.visible = true
      laptop.group.position.copy(lp)
      laptop.group.rotation.y = 0.45
      const shut = easeInOut(prog(t, cue.close, 0.9))
      laptop.hinge.rotation.x = lerp(-0.24, 1.53, shut)
      laptop.screenGlow.material.opacity = 1 - shut
      const termLines = [['› Build the dashboard', '#fff'], ['• Preparing summary cards'], ['• Adding a progress chart'], ['• Checking mobile spacing', C.cyan]]
      laptop.screen.update({ mode: 'terminal', lines: termLines, status: 'working', phase: t * 5, off: shut > 0.98 })
      // The session panel keeps typing throughout, with a growing line count.
      const panel = server.panels[0]
      const slot = V(0, 5.0 + Math.sin(t * 1.3) * 0.1, -1)
      panel.group.position.copy(slot)
      panel.group.lookAt(w.camera.position)
      const progressLines = [['› Build the dashboard', '#ffffff'], ['• Preparing summary cards'], ['• Adding a progress chart'], ['• Checking mobile spacing'], ['✓ Dashboard ready for review', C.mint]]
      const finished = t > cue.back
      panel.show({ tool: 'Codex', title: 'Build the dashboard', lines: progressLines.slice(0, t < cue.keeps ? 3 : t < cue.later + 1 ? 4 : 5), typed: Infinity, status: finished ? 'done' : 'working', phase: t * 5, cursor: true }, { opacity: 1, scale: 1.1, glow: 0.4 + 0.25 * win(t, cue.keeps, cue.later, 0.3, 0.3), glowColor: finished ? '#10b981' : '#3b82f6' })
      // Beam laptop→server, cut when the lid closes; desktop beam later.
      const a1 = lp.clone().add(V(0.6, 2.1, -0.6))
      const b = server.group.position.clone().add(V(0, 3.2, 0.6))
      w.beams[0].show({ a: a1, b, lift: 2.5, draw: 1 - easeIn(prog(t, cue.close + 0.3, 0.7)), pulse: t * 0.6, opacity: 1 - prog(t, cue.close + 0.3, 0.7) })
      const dIn = easeOutBack(prog(t, cue.later + 0.2, 0.9), 1.2)
      desktop.group.visible = dIn > 0
      desktop.group.position.set(dp.x, (1 - dIn) * -2, dp.z)
      desktop.group.rotation.y = -0.45
      desktop.group.scale.setScalar(Math.max(0.001, dIn * 0.9))
      const connected = t > cue.different + 0.9
      desktop.screen.update(connected ? { mode: 'terminal', lines: progressLines.slice(0, finished ? 5 : 4), status: finished ? 'done' : 'working', phase: t * 5 } : { mode: 'dashboard', image: window.FILM_IMAGES.dashboard })
      w.beams[1].show({ a: b, b: dp.clone().add(V(-0.4, 3.4, -0.2)), lift: 2.5, draw: easeInOut(prog(t, cue.different - 0.1, 1)), pulse: t * 0.6, opacity: prog(t, cue.different - 0.1, 0.2), color: '#7cc4ff' })
      if (connected) w.sparks.add({ origin: dp.clone().add(V(0, 2.6, 0.6)), age: t - cue.different - 0.9, seed: 9, count: 100, speed: 3, hex: C.cyan })
      if (finished) w.sparks.add({ origin: slot, age: t - cue.back, seed: 3, count: 160, speed: 4, hex: C.mint })
      reveal(r.head, t, 0.2)
      pin(r.closed, w.project(lp.clone().add(V(0, -0.4, 1.8))), { o: pop(t, cue.close + 0.5) * (1 - prog(t, cue.later + 0.5, 0.4)), s: 0.7 + 0.3 * pop(t, cue.close + 0.5) })
      pin(r.keeps, w.project(slot.clone().add(V(0, 1.55, 0))), { o: pop(t, cue.keeps) * (1 - prog(t, cue.back - 0.3, 0.3)), s: 0.7 + 0.3 * pop(t, cue.keeps) })
      pin(r.later, { x: 960, y: 980 - 60 }, { o: win(t, cue.later - 0.2, cue.different, 0.3, 0.4), s: 0.9 + 0.1 * pop(t, cue.later - 0.2) })
      pin(r.back, w.project(slot.clone().add(V(0, 1.55, 0))), { o: pop(t, cue.back), s: 0.7 + 0.3 * pop(t, cue.back) })
      pin(r.host0, w.project(server.group.position.clone().add(V(0, -0.4, 1.2))), { o: 1 })
    },
  }
}

/* 7 · IMAGES — paste in the manager, send to the session, lands in the prompt. */
function images(cue) {
  return {
    chapter: 'Share images',
    markup: `
      ${heading({ x: 110, y: 110, eyebrow: 'Images', title: 'Paste here.\n<em>Use it there.</em>', sub: 'Send a screenshot or design straight into the remote agent\'s prompt.', width: 640 })}
      ${attachModal()}
      ${terminal({ r: 'term' })}
      <canvas class="trail" data-r="trail" width="1920" height="1080"></canvas>
      <img class="flyimg" data-r="fly" src="${ASSET}dashboard-concept.png">
      <div class="keycap" data-r="keys" style="left:0;top:0"><span>Ctrl</span><span>V</span></div>
      ${chip('sent', 'Sent to Build the dashboard', 'CircleCheck', 'mint')}
      ${cursorMarkup()}`,
    update(t, w, r) {
      w.setCamera(track([[0, 8, 6, 22], [16, 4, 6, 20]], t), [0, 3, 0], 34)
      showServers(w, t, { from: -2 })
      placePanels(w, t, () => -2, { opacity: 0.8 })
      w.renderer.toneMappingExposure = 0.65
      reveal(r.head, t, 0.15)
      // Modal on the left half; terminal on the right, slightly receded.
      const mIn = easeOutBack(prog(t, 0.4, 0.8), 1.1)
      style(r.attach, { o: clamp(mIn * 1.4) * (1 - prog(t, cue.lands + 1.2, 0.5)), x: 110, y: 420 + (1 - mIn) * 60, s: 0.84, origin: '0 0', ry: 8 })
      r.attach.style.top = '0px'
      const pasted = t > cue.paste + 0.35
      r.dropImg.style.opacity = pasted ? 1 : 0
      r.dropImg.style.transform = `scale(${pasted ? 0.85 + 0.15 * easeOutBack(prog(t, cue.paste + 0.35, 0.5), 2) : 0.8})`
      r.dropEmpty.style.opacity = pasted ? 0 : 1
      pin(r.keys, { x: 430, y: 780 }, { o: win(t, cue.paste - 0.4, cue.paste + 1.2, 0.25, 0.3), s: 0.9 + 0.1 * pop(t, cue.paste - 0.4) })
      r.sendBtn.classList.toggle('press', t > cue.send + 0.3 && t < cue.send + 0.5)
      const tIn = easeOut(prog(t, 0.6, 1))
      const focus = easeInOut(prog(t, cue.lands + 1.1, 0.9))
      style(r.term, { o: tIn, x: lerp(900, 820, focus), y: 300 - 120 * focus, s: lerp(0.86, 1.02, focus), origin: '0 0', ry: lerp(-10, -4, focus) })
      r.termLines.innerHTML = '<div class="u">› Build the dashboard interface.</div><div>• Waiting for the design reference.</div>'
      const landed = t > cue.lands + 0.35
      r.termAttach.style.display = landed ? 'block' : 'none'
      r.termPrompt.style.boxShadow = landed ? `0 0 0 ${3 * (1 - prog(t, cue.lands + 0.35, 1.2))}px rgba(124,196,255,0.9), 0 0 ${50 * (1 - prog(t, cue.lands + 0.35, 1.5))}px rgba(124,196,255,0.8)` : 'none'
      r.termInput.textContent = ''
      r.termCaret.style.opacity = Math.floor(t * 2.2) % 2 === 0 ? 1 : 0
      // The image flies from the modal into the terminal prompt along an arc with a light trail.
      const fp = prog(t, cue.send + 0.45, cue.lands + 0.35 - cue.send - 0.45)
      const ctx = r.trail.getContext('2d')
      ctx.clearRect(0, 0, 1920, 1080)
      const from = { x: 330, y: 520 }
      const to = { x: lerp(900, 820, focus) + 120, y: 300 + 560 * 0.86 }
      const at = u => ({ x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u) - Math.sin(u * Math.PI) * 300 })
      if (fp > 0 && fp < 1) {
        const e = easeInOut(fp)
        const p = at(e)
        style(r.fly, { o: 1, x: p.x - 180 * (1 - e * 0.7), y: p.y - 110 * (1 - e * 0.7), s: lerp(0.9, 0.18, e), r: Math.sin(e * Math.PI) * -8, origin: '0 0' })
        ctx.lineCap = 'round'
        for (let k = 0; k < 30; k++) {
          const u0 = Math.max(0, e - 0.02 * (k + 1))
          const u1 = Math.max(0, e - 0.02 * k)
          const p0 = at(u0)
          const p1 = at(u1)
          ctx.strokeStyle = `rgba(124,196,255,${0.5 * (1 - k / 30)})`
          ctx.lineWidth = 10 * (1 - k / 30)
          ctx.beginPath()
          ctx.moveTo(p0.x, p0.y)
          ctx.lineTo(p1.x, p1.y)
          ctx.stroke()
        }
      } else r.fly.style.opacity = 0
      pin(r.sent, { x: to.x + 560, y: to.y - 190 }, { o: pop(t, cue.lands + 0.4) * (1 - prog(t, cue.nomore + 1.6, 0.4)), s: 0.7 + 0.3 * pop(t, cue.lands + 0.4) })
      driveCursor(r, t, [[0, 900, 900, 0], [cue.send - 0.6, 700, 800, 1], [cue.send + 0.3, 662, 868, 1], [cue.send + 0.8, 700, 900, 1], [cue.send + 1.2, 760, 960, 0]], [cue.send + 0.3])
      if (landed) w.sparks.add({ origin: V(0, 3, 4), age: t - cue.lands - 0.35, seed: 21, count: 80, speed: 2.5, hex: '#7cc4ff' })
    },
  }
}

/* 8 · SEARCH — search on the server; history stays; only snippets come back. */
function search(cue) {
  return {
    chapter: 'Find past conversations',
    markup: `
      ${heading({ x: 110, y: 110, eyebrow: 'Conversation search', title: 'Find that\n<em>conversation.</em>', width: 640 })}
      <div class="badges" data-r="kinds" style="left:110px;top:420px">
        <div class="badge" data-r="k0">Topic</div><div class="badge" data-r="k1">Phrase</div><div class="badge" data-r="k2">Error message</div>
      </div>
      ${finderCard()}
      ${chip('runs', 'Search runs on the server', 'Server', 'cyan')}
      ${chip('stays', 'History stays here', 'ShieldCheck', 'blue')}
      ${chip('snips', 'Only matching snippets return', 'ArrowRight', 'amber')}
      ${cursorMarkup()}`,
    update(t, w, r) {
      // Phase A: UI (left), dim world. Phase B: 3D close-up of the server scanning its history.
      const phaseB = easeInOut(prog(t, cue.runs - 0.6, 1))
      const server = w.servers[0]
      server.group.visible = true
      server.group.position.set(0, 0, 0)
      server.group.scale.setScalar(1)
      w.animateServer(server, t, { intensity: 1 + phaseB * 0.3 })
      for (const s of w.servers.slice(1)) {
        s.group.visible = phaseB < 0.99
        w.animateServer(s, t)
      }
      w.setCamera(track([[0, 4, 7, 24], [cue.runs - 0.6, 3, 7, 22], [cue.runs + 0.4, -0.6, 4.4, 13], [17, -1.8, 4.6, 12.5]], t), track([[0, 0, 3, 0], [cue.runs - 0.6, 0, 3, 0], [cue.runs + 0.4, -1.1, 2.9, 0], [17, -1.1, 2.9, 0]], t), 36)
      w.renderer.toneMappingExposure = lerp(0.7, 1.1, phaseB)
      reveal(r.head, t, 0.15, { until: cue.runs - 0.2 })
      ;[cue.search, cue.phrase, cue.error].forEach((at, i) => reveal(r[`k${i}`], t, at - 0.15, { until: cue.runs - 0.2, y: 20, dur: 0.45 }))
      const fIn = easeOutBack(prog(t, 0.3, 0.8), 1.1)
      style(r.finder, { o: clamp(fIn * 1.4) * (1 - phaseB), x: 900 - phaseB * 300, y: 90 + (1 - fIn) * 60, s: 0.95 - phaseB * 0.15, origin: '0 0', ry: -6 + phaseB * 20, blur: phaseB * 8 })
      r.kw.textContent = typed('retry', t, cue.search + 0.3, 10)
      r.kwField.classList.toggle('focus', t > cue.search && t < cue.reopen)
      r.kwCaret.style.opacity = t > cue.search && t < cue.reopen && Math.floor(t * 2.4) % 2 === 0 ? 1 : 0
      const searched = cue.search + 1.4
      r.searchBtn.classList.toggle('press', t > searched && t < searched + 0.2)
      reveal(r.count, t, searched + 0.4, { y: 10, dur: 0.4 })
      reveal(r.res1, t, searched + 0.6, { y: 24, dur: 0.5 })
      reveal(r.res2, t, searched + 0.8, { y: 24, dur: 0.5 })
      r.res1Btn.classList.toggle('press', t > cue.reopen + 0.3 && t < cue.reopen + 0.5)
      r.res1Btn.style.borderColor = t > cue.reopen ? '#2563eb' : ''
      driveCursor(r, t, [[0, 1600, 900, 0], [cue.search - 0.4, 1300, 360, 1], [cue.search, 1250, 345, 1], [searched - 0.4, 1640, 345, 1], [searched, 1650, 343, 1], [cue.reopen - 0.3, 1680, 560, 1], [cue.reopen + 0.3, 1670, 546, 1], [cue.runs - 0.8, 1700, 600, 1], [cue.runs - 0.4, 1720, 640, 0]], [cue.search, searched, cue.reopen + 0.3])
      // History cards orbit the server; a scan ring sweeps and two matches lift out.
      const show = prog(t, cue.runs - 0.8, 0.8)
      w.history.forEach(card => {
        const { i, hit } = card.userData
        card.visible = show > 0
        const layer = i % 3
        const angle = (i / 34) * Math.PI * 2 * 3 + t * (0.12 + layer * 0.04)
        const radius = 2.4 + layer * 0.55
        const y = 0.6 + (i % 7) * 0.42
        const base = V(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
        const lift = hit ? easeInOut(prog(t, cue.snippets - 0.1 + (i === 22 ? 0.25 : 0), 1.2)) : 0
        const target = V(i === 9 ? -3.6 : -1.3, 4.0, 4.2)
        card.position.copy(base.lerp(target, lift))
        card.lookAt(w.camera.position)
        card.scale.setScalar((0.6 + 0.4 * show) * (1 + lift * 1.1))
        const scanY = 0.4 + ((t - cue.runs) * 1.4) % 3.2
        const lit = !hit && Math.abs(card.position.y - scanY) < 0.25 && t > cue.runs
        card.material.opacity = show * (hit ? 1 : lit ? 1 : 0.55) * (hit ? 1 : 1 - 0.5 * prog(t, cue.snippets, 1))
      })
      const scan = t > cue.runs
      w.scanRing.visible = w.scanDisc.visible = scan
      const scanY = 0.4 + ((t - cue.runs) * 1.4) % 3.2
      w.scanRing.position.set(0, scanY, 0)
      w.scanRing.scale.setScalar(1.4)
      w.scanRing.material.opacity = 0.8 * prog(t, cue.runs, 0.4)
      w.scanDisc.position.set(0, scanY, 0)
      w.scanDisc.scale.setScalar(1.4)
      pin(r.runs, w.project(V(2.9, 3.5, 1)), { o: pop(t, cue.runs + 0.2), s: 0.7 + 0.3 * pop(t, cue.runs + 0.2) })
      pin(r.stays, w.project(V(2.6, 0.8, 2)), { o: pop(t, cue.stays), s: 0.7 + 0.3 * pop(t, cue.stays) })
      pin(r.snips, w.project(V(-2.45, 4.75, 4.2)), { o: pop(t, cue.snippets + 0.6), s: 0.7 + 0.3 * pop(t, cue.snippets + 0.6) })
    },
  }
}

/* 9 · ACTIVITY — working / idle / waiting; check in and the notice clears. */
function activity(cue) {
  return {
    chapter: 'Know where you\'re needed',
    markup: `
      ${heading({ x: 260, y: 96, eyebrow: 'Activity', title: 'See where you\'re <em>needed.</em>', width: 1400, align: 'center' })}
      ${chip('cw', 'Working', 'LoaderCircle', 'blue')}${chip('ci', 'Idle', null, 'dim')}${chip('ca', 'Waiting for you', 'Bell', 'amber')}
      <div class="shot" data-r="shot" style="left:0;top:0;width:1264px;height:505px">
        <img data-r="before" src="${ASSET}screenshots/activity-before-focus.png" width="1264" height="505">
        <img class="over" data-r="after" src="${ASSET}screenshots/activity-checked-focus.png" width="1264" height="505">
        <div class="ring" data-r="ring" style="position:absolute;left:570px;top:256px;width:110px;height:40px"></div>
      </div>
      ${cursorMarkup()}`,
    update(t, w, r) {
      // Every server panel shows a live status; the "waiting" one pulses amber.
      const states = [['working', 'idle'], ['working', 'waiting', 'idle'], ['working', 'idle']]
      const checked = t > cue.check + 0.5
      const toUi = easeInOut(prog(t, cue.check - 0.9, 0.8))
      w.setCamera(track([[0, 0, 8.5, 25], [cue.check - 0.9, 1.5, 7.5, 22], [16, 2, 8, 24]], t), [0, 3.0, 0], 34)
      showServers(w, t, { from: -2 })
      w.renderer.toneMappingExposure = 1.05 - toUi * 0.35
      placePanels(w, t, () => -2, {
        state: (i, j) => {
          const s = states[i][j]
          const lit = s === 'working' ? win(t, cue.working - 0.2, cue.idle, 0.2, 0.3) : s === 'idle' ? win(t, cue.idle - 0.2, cue.waiting, 0.2, 0.3) : (t > cue.waiting - 0.2 && !checked ? 1 : 0)
          const status = s === 'waiting' && checked ? 'idle' : s
          return { status, highlight: lit > 0.5, glow: 0.25 + lit * 0.6 * (s === 'waiting' ? 0.6 + 0.4 * Math.sin(t * 6) : 1), glowColor: s === 'waiting' ? '#f59e0b' : s === 'idle' ? '#64748b' : '#3b82f6', typedFrom: s === 'idle' ? -100 : -2 }
        },
      })
      reveal(r.head, t, 0.2, { until: cue.check - 0.6 })
      const anchor = (i, j) => w.project(panelSlot(w.servers[i], j, LAYOUT[i].length, t, {}).add(V(0, 1.15, 0)))
      pin(r.cw, anchor(0, 0), { o: pop(t, cue.working) * (1 - toUi), s: 0.7 + 0.3 * pop(t, cue.working) })
      pin(r.ci, anchor(2, 1), { o: pop(t, cue.idle) * (1 - toUi), s: 0.7 + 0.3 * pop(t, cue.idle) })
      pin(r.ca, anchor(1, 1), { o: pop(t, cue.waiting) * (1 - toUi), s: (0.7 + 0.3 * pop(t, cue.waiting)) * (1 + 0.05 * Math.sin(t * 6)) })
      // Then the real session list: the "Awaiting you" badge, a click, the notice clears.
      style(r.shot, { o: toUi, x: 328, y: 330 + (1 - toUi) * 80, s: 0.92 + 0.08 * toUi, rx: (1 - toUi) * 12 })
      r.after.style.opacity = checked ? 1 : 0
      // Badge bounds measured from the screenshots: "Awaiting you" 576–673 × 262–289, then "• Idle" 572–607 × 266–284.
      const shrink = easeInOut(prog(t, cue.check + 0.5, 0.35))
      Object.assign(r.ring.style, { left: `${lerp(570, 562, shrink)}px`, top: `${lerp(256, 260, shrink)}px`, width: `${lerp(110, 54, shrink)}px`, height: `${lerp(40, 30, shrink)}px` })
      r.ring.style.opacity = checked ? 1 - prog(t, cue.clears + 1.4, 0.6) : 0.6 + 0.4 * Math.sin(t * 6)
      r.ring.classList.toggle('mint', checked)
      const connectBtn = { x: 328 + 1126, y: 330 + 289 }
      driveCursor(r, t, [[0, 1400, 900, 0], [cue.check - 0.4, 1500, 820, 1], [cue.check + 0.3, connectBtn.x, connectBtn.y, 1], [cue.clears + 1, connectBtn.x + 60, connectBtn.y + 80, 1], [cue.clears + 1.6, connectBtn.x + 90, connectBtn.y + 110, 0]], [cue.check + 0.35])
    },
  }
}

/* 10 · ARCHITECTURE — agentless servers; adapters for custom harnesses. */
const MID = 2.4 // shared x-centre of the server, the rail, and its four module slots
function architecture(cue) {
  return {
    chapter: 'Simple by design',
    markup: `
      ${heading({ x: 110, y: 110, eyebrow: 'Under the hood', title: 'Agentless servers.\n<em>Room to grow.</em>', width: 820 })}
      <div class="badges" data-r="pts" style="left:0;right:0;top:800px;justify-content:center">
        <div class="badge strike" data-r="p0">${icon('X', 24)}<span>No extra service on your servers</span></div>
        <div class="badge" data-r="p1">${icon('Puzzle', 24)}Custom AI harnesses plug in</div>
      </div>
      ${chip('svc', 'No manager service', 'X', 'red')}`,
    update(t, w, r) {
      const server = w.servers[1]
      server.group.visible = true
      server.group.position.set(MID, 0, 0)
      w.animateServer(server, t)
      const toRail = easeInOut(prog(t, cue.grow - 0.6, 1.2))
      w.setCamera(track([[0, MID - 0.9, 3.8, 12], [cue.grow - 0.6, MID, 3.8, 11], [cue.grow + 0.6, MID, 3.4, 14], [14.5, MID, 3.6, 14.5]], t), track([[0, MID - 0.9, 3.2, 0], [cue.grow - 0.6, MID, 3.0, 0], [cue.grow + 0.6, MID, 2.4, 0], [14.5, MID, 2.4, 0]], t), 36)
      w.renderer.toneMappingExposure = 1.05
      // A ghost "manager service" box tries to dock onto the server, then dissolves.
      const gIn = easeOut(prog(t, cue.agentless - 0.4, 0.5))
      const gOut = prog(t, cue.service + 0.5, 0.8)
      w.ghost.visible = gIn > 0 && gOut < 1
      w.ghost.position.set(MID, 4.1 + (1 - gIn) * 1.2 + Math.sin(t * 2) * 0.05, 0.2)
      w.ghost.rotation.y = t * 0.6
      w.ghost.material.opacity = gIn * (1 - gOut)
      w.ghost.scale.setScalar(1 + gOut * 0.6)
      if (gOut > 0) w.sparks.add({ origin: V(MID, 4.1, 0.2), age: t - cue.service - 0.5, seed: 17, count: 140, speed: 3, hex: C.red, gravity: -1 })
      pin(r.svc, w.project(V(MID, 5.4, 0.2)), { o: pop(t, cue.service) * (1 - gOut), s: 0.7 + 0.3 * pop(t, cue.service) })
      server.panels.forEach(p => p.reset())
      const panel = server.panels[0]
      panel.group.position.set(MID, 5.0 + Math.sin(t * 1.3) * 0.08 - toRail * 5, -0.6)
      panel.group.lookAt(w.camera.position)
      panel.show(panelState('Codex', t), { opacity: (1 - toRail) * easeOut(prog(t, 0, 0.6)), scale: 0.95 })
      // An adapter rail rises in front of the server; modules slot in, and "Yours" snaps in last.
      w.rail.visible = w.railGlow.visible = toRail > 0
      w.rail.position.set(MID, 2.0 + (1 - toRail) * -2, 3)
      w.railGlow.position.set(MID, w.rail.position.y + 0.1, 3.36)
      w.railGlow.material.color.set(C.blue).multiplyScalar(0.6 + 0.4 * Math.sin(t * 3))
      w.modules.forEach((module, i) => {
        const at = i < 3 ? cue.grow + 0.2 + i * 0.25 : cue.custom + 0.2
        const p = clamp((t - at) / (i < 3 ? 0.6 : 0.9))
        module.group.visible = p > 0
        const x = MID + (i - 1.5) * 2.35
        const e = i < 3 ? easeOutBack(p, 1.3) : springy(p)
        module.group.position.set(x, 2.95 + (1 - e) * (i < 3 ? 2 : 3.2), 3)
        module.group.rotation.set(0, 0, (1 - clamp(e)) * (i === 3 ? 0.6 : 0))
        module.group.scale.setScalar(Math.max(0.001, i === 3 ? 0.6 + 0.4 * clamp(e) : 1))
        module.glow.material.opacity = 0.35 + (i === 3 ? 0.5 * Math.exp(-((t - at - 0.6) ** 2) * 3) : 0)
        if (i === 3 && p >= 1) w.sparks.add({ origin: V(x, 2.6, 3.3), age: t - at - 0.9, seed: 31, count: 120, speed: 3, hex: C.amber })
      })
      reveal(r.head, t, 0.2)
      reveal(r.p0, t, cue.service - 0.1, { y: 20 })
      reveal(r.p1, t, cue.custom - 0.1, { y: 20 })
      r.pts.style.opacity = 1
      r.pts.style.visibility = 'visible'
    },
  }
}

/* 11 · OUTRO */
function outro(cue) {
  return {
    chapter: '',
    markup: `
      <div class="brand" data-r="brand" style="top:545px"><div class="name">Outpost</div><div class="tag2">AI Session Manager</div></div>
      <div class="brand" data-r="lines" style="top:770px"><span class="line" data-r="l1">Keep the session.</span><span class="line" data-r="l2"><em>Keep your flow.</em></span></div>`,
    update(t, w, r) {
      // Wide orbit over everything, then everything converges into the logo.
      const orbit = t * 0.06
      const converge = easeInOut(prog(t, cue.name - 1.1, 1.3))
      const radius = lerp(25, 12, converge)
      w.setCamera([Math.sin(orbit) * radius, lerp(10, 4.8, converge), Math.cos(orbit) * radius], [0, lerp(3, 4.3, converge), 0], 34)
      showServers(w, t, { from: -2 })
      w.servers.forEach(server => {
        server.group.scale.setScalar(Math.max(0.001, 1 - converge))
        server.group.position.y = -converge * 2
      })
      placePanels(w, t, () => -2, { opacity: 1 - converge })
      const { laptop, desktop } = w.devices
      for (const [device, pos, ry] of [[laptop, V(-5.5, 0, 6.5), 0.5], [desktop, V(5.5, 0, 6), -0.5]]) {
        device.group.visible = converge < 1
        device.group.position.copy(pos)
        device.group.rotation.y = ry
        device.group.scale.setScalar(Math.max(0.001, (1 - converge) * 0.9))
        device.screen.update({ mode: 'dashboard', image: window.FILM_IMAGES.dashboard })
      }
      laptop.hinge.rotation.x = -0.24
      w.beams.slice(0, 6).forEach((beam, k) => {
        const device = k < 3 ? laptop : desktop
        const from = device.group.position.clone().add(k < 3 ? V(0, 2.1, -1.1) : V(0, 3.4, -0.1))
        const server = w.servers[k % 3]
        beam.show({ a: from, b: server.group.position.clone().add(V(0, 3.4 * (1 - converge), 0.3)), lift: 3.5, draw: 1, pulse: t * 0.45 + k * 0.17, opacity: 0.8 * (1 - converge), color: k < 3 ? C.cyan : '#7cc4ff' })
      })
      const logoIn = easeOutBack(prog(t, cue.name - 0.4, 1), 1.3)
      w.logo.visible = logoIn > 0
      w.logo.position.set(0, 5.6, 0)
      w.logo.scale.setScalar(Math.max(0.001, logoIn * 0.85))
      w.logo.lookAt(w.camera.position)
      w.ring.scale.setScalar(1 + prog(t, cue.name - 0.2, 1.6) * 3)
      w.ring.material.opacity = (1 - prog(t, cue.name - 0.2, 1.6)) * 0.9
      w.logoGlow.material.opacity = 0.9
      if (t > cue.name - 0.3) w.sparks.add({ origin: V(0, 5.6, 0), age: t - cue.name + 0.3, seed: 41, count: 260, speed: 6, gravity: -0.6, life: 2.2, hex: '#7cc4ff' })
      w.renderer.toneMappingExposure = 1.05 + 0.45 * Math.exp(-((t - cue.name) ** 2) * 5)
      w.floor.material.uniforms.uPulseOrigin.value.set(0, 0)
      w.floor.material.uniforms.uPulse.value = t > cue.name - 0.3 ? clamp((t - cue.name + 0.3) / 2.6) : 0
      reveal(r.brand, t, cue.name - 0.1, { dur: 0.8, s: 0.96 })
      reveal(r.l1, t, cue.session - 0.1, { dur: 0.6, y: 20 })
      reveal(r.l2, t, cue.flow - 0.1, { dur: 0.6, y: 20 })
      r.lines.style.opacity = 1
      r.lines.style.visibility = 'visible'
    },
  }
}

export const sceneFactories = { hook, friction, reveal: reveal3, create, connect, persist, images, search, activity, architecture, outro }
// Scenes whose UI sits on the left over a busy 3D background get a darkening gradient.
export const shaded = { create: 0.9, connect: 0.85, images: 0.85, search: 0.85, activity: 0.5, architecture: 0.85, friction: 0.85, persist: 0.6, hook: 0.5, reveal: 0.3 }
