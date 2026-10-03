// The persistent 3D world: a grid floor with dev-server towers, floating session
// terminals, access devices, connection beams, and effect particles.
// Everything is driven by explicit state per frame — no clocks, no tweens.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Painted, drawSession, drawScreen, drawModule, drawLogo, C } from './textures.js'
import { rng } from './util.js'

const BG = new THREE.Color('#050a16')

function glowTexture(inner = 'rgba(255,255,255,1)', stops = [[0, 1], [0.25, 0.45], [1, 0]]) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  for (const [at, alpha] of stops) g.addColorStop(at, inner.replace(/[\d.]+\)$/, `${alpha})`))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
const GLOW = glowTexture()
const SHADOW = glowTexture('rgba(0,0,0,1)', [[0, 0.75], [0.5, 0.35], [1, 0]])

function glowSprite(color, size) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  sprite.scale.set(size, size, 1)
  return sprite
}

function floor() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uBg: { value: BG }, uPulse: { value: 0 }, uPulseOrigin: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec3 vPos; void main(){ vPos = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vPos,1.0); }',
    fragmentShader: `
      uniform vec3 uBg; uniform float uPulse; uniform vec2 uPulseOrigin; varying vec3 vPos;
      float grid(vec2 p, float size){ vec2 q = p / size; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        float d = length(vPos.xz - vec2(0.0, 1.5));
        float fade = exp(-d * 0.055);
        vec3 col = vec3(0.035, 0.065, 0.13);
        col += vec3(0.22, 0.45, 0.95) * (grid(vPos.xz, 1.0) * 0.16 + grid(vPos.xz, 5.0) * 0.32);
        col += vec3(0.12, 0.32, 0.8) * 0.22 * exp(-d * 0.16);
        float r = length(vPos.xz - uPulseOrigin);
        col += vec3(0.25, 0.75, 1.0) * smoothstep(1.2, 0.0, abs(r - uPulse * 26.0)) * (1.0 - uPulse) * step(0.001, uPulse) * 0.9;
        gl_FragColor = vec4(mix(uBg, col, fade), 1.0);
        #include <colorspace_fragment>
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), material)
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

function dust() {
  const random = rng(7)
  const count = 1400
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * 90
    positions[i * 3 + 1] = random() * 26 + 0.3
    positions[i * 3 + 2] = (random() - 0.5) * 70 - 8
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#6ea8ff', size: 0.07, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }))
}

// A session terminal floating in space.
class Panel {
  constructor(parent) {
    this.painted = new Painted(1024, 620, drawSession)
    this.material = new THREE.MeshBasicMaterial({ map: this.painted.texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6 * 620 / 1024), this.material)
    this.glow = glowSprite('#3b82f6', 4.2)
    this.glow.position.z = -0.05
    this.group = new THREE.Group()
    this.group.add(this.glow, this.mesh)
    parent.add(this.group)
  }
  reset() { this.group.visible = false; this.opacity = 1; this.group.scale.setScalar(1); this.group.rotation.set(0, 0, 0) }
  show(state, { opacity = 1, scale = 1, glow = 0.35, glowColor = '#3b82f6' } = {}) {
    this.group.visible = opacity > 0.002
    this.painted.update(state)
    this.material.opacity = opacity
    this.glow.material.opacity = opacity * glow
    this.glow.material.color.set(glowColor)
    this.group.scale.setScalar(Math.max(0.001, scale))
  }
}

function serverTower() {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new RoundedBoxGeometry(2.1, 3.4, 1.9, 4, 0.14), new THREE.MeshStandardMaterial({ color: '#1a2438', metalness: 0.75, roughness: 0.32 }))
  body.position.y = 1.7
  group.add(body)
  const bladeMaterial = new THREE.MeshStandardMaterial({ color: '#0e1524', metalness: 0.5, roughness: 0.5 })
  const leds = []
  for (let i = 0; i < 6; i++) {
    const blade = new THREE.Mesh(new RoundedBoxGeometry(1.8, 0.36, 0.08, 2, 0.03), bladeMaterial)
    blade.position.set(0, 0.55 + i * 0.47, 0.96)
    group.add(blade)
    const led = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), new THREE.MeshBasicMaterial({ color: C.cyan, toneMapped: false }))
    led.position.set(-0.7, blade.position.y, 1.005)
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.04), new THREE.MeshBasicMaterial({ color: '#2b5bd7', toneMapped: false, transparent: true, opacity: 0.8 }))
    bar.position.set(0.2, blade.position.y, 1.005)
    group.add(led, bar)
    leds.push({ led, bar })
  }
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.1, 0.05), new THREE.MeshBasicMaterial({ color: C.blue, toneMapped: false }))
  strip.position.set(-1.07, 1.7, 0.92)
  const strip2 = strip.clone()
  strip2.position.x = 1.07
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), new THREE.MeshBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.35, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false }))
  cap.rotation.x = -Math.PI / 2
  cap.position.y = 3.415
  const shadow = new THREE.Sprite(new THREE.SpriteMaterial({ map: SHADOW, transparent: true, depthWrite: false }))
  const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ map: GLOW, color: '#2563eb', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))
  floorGlow.rotation.x = -Math.PI / 2
  floorGlow.position.y = 0.01
  shadow.visible = false
  group.add(strip, strip2, cap, floorGlow)
  return { group, body, leds, strips: [strip, strip2], cap, floorGlow }
}

class Beam {
  constructor(parent, color = C.cyan) {
    this.group = new THREE.Group()
    this.core = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    this.halo = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    this.meshes = []
    this.pulses = Array.from({ length: 4 }, () => glowSprite(color, 0.7))
    this.group.add(...this.pulses)
    parent.add(this.group)
    this.key = ''
  }
  build(a, b, lift) {
    const key = [a.toArray(), b.toArray(), lift].flat().map(v => v.toFixed(2)).join()
    if (key === this.key) return
    this.key = key
    for (const mesh of this.meshes) { this.group.remove(mesh); mesh.geometry.dispose() }
    const mid = a.clone().lerp(b, 0.5)
    mid.y += lift
    this.curve = new THREE.QuadraticBezierCurve3(a, mid, b)
    // Two segments (before/after a gap), each with a core and a halo tube.
    const tube = radius => new THREE.TubeGeometry(this.curve, 80, radius, 6)
    this.meshes = [new THREE.Mesh(tube(0.028), this.core), new THREE.Mesh(tube(0.028), this.core), new THREE.Mesh(tube(0.11), this.halo), new THREE.Mesh(tube(0.11), this.halo)]
    for (const mesh of this.meshes) mesh.frustumCulled = false
    this.group.add(...this.meshes)
  }
  reset() { this.group.visible = false }
  // draw: portion of the path [0..1] drawn; gap: [g0, g1] hidden fraction.
  show({ a, b, lift = 2, draw = 1, gap = null, opacity = 1, color = C.cyan, pulse = null }) {
    this.build(a, b, lift)
    this.group.visible = opacity > 0.002
    this.core.opacity = opacity
    this.halo.opacity = opacity * 0.2
    this.core.color.set(color)
    this.halo.color.set(color)
    const per = 6 * 6
    const ranges = gap ? [[0, Math.min(draw, gap[0])], [gap[1], draw]] : [[0, draw], [0, 0]]
    ranges.forEach(([from, to], i) => {
      for (const mesh of [this.meshes[i], this.meshes[i + 2]]) {
        const start = Math.floor(Math.max(0, from) * 80) * per
        const end = Math.floor(Math.max(0, to) * 80) * per
        mesh.geometry.setDrawRange(start, Math.max(0, end - start))
        mesh.visible = end > start
      }
    })
    this.pulses.forEach((sprite, i) => {
      const u = pulse === null ? -1 : (pulse + i / this.pulses.length) % 1
      sprite.visible = u >= 0 && u <= draw && !(gap && u > gap[0] && u < gap[1])
      if (sprite.visible) sprite.position.copy(this.curve.getPoint(u))
      sprite.material.opacity = opacity * 0.9
      sprite.material.color.set(color)
    })
  }
}

function laptop() {
  const group = new THREE.Group()
  const shell = new THREE.MeshStandardMaterial({ color: '#c9d3e3', metalness: 0.85, roughness: 0.28 })
  const base = new THREE.Mesh(new RoundedBoxGeometry(3.2, 0.13, 2.2, 3, 0.05), shell)
  base.position.y = 0.065
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.1), new THREE.MeshStandardMaterial({ color: '#1b2333', roughness: 0.7 }))
  deck.rotation.x = -Math.PI / 2
  deck.position.set(0, 0.132, -0.25)
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.55), new THREE.MeshStandardMaterial({ color: '#aab6c8', metalness: 0.6, roughness: 0.4 }))
  pad.rotation.x = -Math.PI / 2
  pad.position.set(0, 0.132, 0.65)
  const hinge = new THREE.Group()
  hinge.position.set(0, 0.13, -1.08)
  const lid = new THREE.Mesh(new RoundedBoxGeometry(3.2, 2.1, 0.08, 3, 0.04), shell)
  lid.position.set(0, 1.05, -0.02)
  const screen = new Painted(1280, 800, drawScreen)
  const display = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.875), new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false }))
  display.position.set(0, 1.07, 0.025)
  const screenGlow = glowSprite('#3b82f6', 6)
  screenGlow.position.set(0, 1.0, 0.4)
  hinge.add(lid, display, screenGlow)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5, 4), new THREE.MeshBasicMaterial({ map: SHADOW, transparent: true, depthWrite: false, opacity: 0.8 }))
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.005
  group.add(shadow, base, deck, pad, hinge)
  return { group, hinge, screen, screenGlow, anchor: new THREE.Vector3(0, 2.2, -1.1) }
}

function desktop() {
  const group = new THREE.Group()
  const shell = new THREE.MeshStandardMaterial({ color: '#202a3c', metalness: 0.7, roughness: 0.3 })
  const silver = new THREE.MeshStandardMaterial({ color: '#c9d3e3', metalness: 0.85, roughness: 0.28 })
  const frame = new THREE.Mesh(new RoundedBoxGeometry(4.2, 2.6, 0.14, 3, 0.06), shell)
  frame.position.y = 2.35
  const screen = new Painted(1280, 760, drawScreen)
  const display = new THREE.Mesh(new THREE.PlaneGeometry(3.98, 2.36), new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false }))
  display.position.set(0, 2.35, 0.075)
  const neck = new THREE.Mesh(new RoundedBoxGeometry(0.4, 1.3, 0.2, 2, 0.05), silver)
  neck.position.set(0, 0.85, -0.15)
  const foot = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.08, 1.1, 2, 0.04), silver)
  foot.position.y = 0.04
  const screenGlow = glowSprite('#3b82f6', 7)
  screenGlow.position.set(0, 2.35, 0.5)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5, 3.5), new THREE.MeshBasicMaterial({ map: SHADOW, transparent: true, depthWrite: false, opacity: 0.8 }))
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.005
  group.add(shadow, frame, display, neck, foot, screenGlow)
  return { group, screen, screenGlow, anchor: new THREE.Vector3(0, 3.7, -0.1) }
}

// Deterministic particle bursts: positions are a pure function of age.
class Sparks {
  constructor(parent, max = 900) {
    this.max = max
    this.positions = new Float32Array(max * 3)
    this.colors = new Float32Array(max * 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    this.points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, map: GLOW, toneMapped: false }))
    this.points.frustumCulled = false
    parent.add(this.points)
    this.bursts = []
  }
  reset() { this.bursts = [] }
  add(burst) { this.bursts.push(burst) }
  apply() {
    let n = 0
    const color = new THREE.Color()
    for (const { origin, age, seed = 1, count = 120, speed = 3, gravity = -2, life = 1.4, hex = C.cyan, spread = 1 } of this.bursts) {
      if (age < 0 || age > life) continue
      const random = rng(seed)
      color.set(hex)
      const fade = (1 - age / life) ** 1.5
      for (let i = 0; i < count && n < this.max; i++, n++) {
        const theta = random() * Math.PI * 2
        const phi = Math.acos(2 * random() - 1)
        const v = speed * (0.35 + random() * 0.65)
        const dx = Math.sin(phi) * Math.cos(theta) * spread
        const dy = Math.abs(Math.cos(phi)) * 0.8 + 0.2
        const dz = Math.sin(phi) * Math.sin(theta) * spread
        const k = 1 - Math.exp(-age * 2.2)
        this.positions[n * 3] = origin.x + dx * v * k / 2.2
        this.positions[n * 3 + 1] = origin.y + dy * v * k / 2.2 + 0.5 * gravity * age * age
        this.positions[n * 3 + 2] = origin.z + dz * v * k / 2.2
        this.colors[n * 3] = color.r * fade
        this.colors[n * 3 + 1] = color.g * fade
        this.colors[n * 3 + 2] = color.b * fade
      }
    }
    this.points.geometry.setDrawRange(0, n)
    this.points.geometry.attributes.position.needsUpdate = true
    this.points.geometry.attributes.color.needsUpdate = true
  }
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setSize(1920, 1080, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = BG
  scene.fog = new THREE.Fog(BG, 30, 95)
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.55

  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.1, 300)
  scene.add(new THREE.HemisphereLight('#8fb5ff', '#0a1020', 0.9))
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(6, 14, 10)
  const rim = new THREE.DirectionalLight('#3fa9ff', 1.4)
  rim.position.set(-10, 6, -12)
  scene.add(key, rim)

  const floorMesh = floor()
  scene.add(floorMesh)
  const dustPoints = dust()
  scene.add(dustPoints)

  const hosts = ['atlas.example.com', 'lab.example.com', 'gpu.example.com']
  const servers = hosts.map((host, i) => {
    const tower = serverTower()
    tower.host = host
    tower.home = new THREE.Vector3((i - 1) * 7, 0, 0)
    tower.group.position.copy(tower.home)
    tower.panels = [0, 1, 2].map(() => new Panel(scene))
    scene.add(tower.group)
    return tower
  })
  const devices = { laptop: laptop(), desktop: desktop() }
  scene.add(devices.laptop.group, devices.desktop.group)
  const beams = Array.from({ length: 7 }, () => new Beam(scene))
  const sparks = new Sparks(scene)

  // Brand mark for the reveal and the ending.
  const logoTexture = new Painted(1024, 1024, drawLogo)
  const logo = new THREE.Group()
  const logoMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: logoTexture.texture, transparent: true, toneMapped: false, depthWrite: false }))
  const logoGlow = glowSprite('#3b82f6', 9)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 128), new THREE.MeshBasicMaterial({ color: '#7cc4ff', transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
  logoMesh.renderOrder = 2
  logo.add(logoGlow, logoMesh, ring)
  scene.add(logo)

  // Conversation history around a server, for the search scene.
  const historyTexture = new Painted(256, 160, (ctx, w, h, s) => {
    ctx.fillStyle = s.hit ? 'rgba(251,191,36,0.22)' : 'rgba(20,32,58,0.9)'
    ctx.strokeStyle = s.hit ? C.amber : 'rgba(120,160,230,0.6)'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.roundRect(4, 4, w - 8, h - 8, 18)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = s.hit ? C.amber : 'rgba(170,195,240,0.55)'
    for (let i = 0; i < 4; i++) ctx.fillRect(24, 30 + i * 28, (i % 2 ? 150 : 200) - i * 10, 10)
  })
  historyTexture.update({ hit: false })
  const hitTexture = new Painted(256, 160, historyTexture.draw)
  hitTexture.update({ hit: true })
  const history = Array.from({ length: 34 }, (_, i) => {
    const hit = i === 9 || i === 22
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.39), new THREE.MeshBasicMaterial({ map: (hit ? hitTexture : historyTexture).texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
    mesh.userData = { i, hit }
    scene.add(mesh)
    return mesh
  })
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.025, 8, 120), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
  scanRing.rotation.x = Math.PI / 2
  const scanDisc = new THREE.Mesh(new THREE.CircleGeometry(2.2, 96), new THREE.MeshBasicMaterial({ map: GLOW, color: C.cyan, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
  scanDisc.rotation.x = -Math.PI / 2
  scene.add(scanRing, scanDisc)

  // Architecture: a ghost of the service we do *not* install, and pluggable adapters.
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.6, 1.2, 1.4)), new THREE.LineDashedMaterial({ color: C.red, dashSize: 0.12, gapSize: 0.08, transparent: true }))
  ghost.computeLineDistances()
  scene.add(ghost)
  const rail = new THREE.Mesh(new RoundedBoxGeometry(9.4, 0.18, 0.7, 2, 0.06), new THREE.MeshStandardMaterial({ color: '#24314a', metalness: 0.7, roughness: 0.35 }))
  const railGlow = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: C.blue, toneMapped: false }))
  scene.add(rail, railGlow)
  const modules = [['Codex', 'Codex'], ['Claude Code', 'Claude'], ['Kimi', 'Kimi'], ['Custom', 'Yours']].map(([tool, label], i) => {
    const painted = new Painted(512, 360, drawModule)
    painted.update({ tool, label, custom: tool === 'Custom' })
    const group = new THREE.Group()
    const body = new THREE.Mesh(new RoundedBoxGeometry(2.0, 1.4, 0.5, 3, 0.1), new THREE.MeshStandardMaterial({ color: '#141d30', metalness: 0.6, roughness: 0.4, transparent: true }))
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.94, 1.36), new THREE.MeshBasicMaterial({ map: painted.texture, transparent: true, toneMapped: false }))
    face.position.z = 0.26
    const glow = glowSprite(i === 3 ? C.amber : '#3b82f6', 4)
    glow.position.z = -0.2
    group.add(glow, body, face)
    scene.add(group)
    return { group, body, face, glow }
  })

  const all = { logoTexture, renderer, scene, camera, servers, devices, beams, sparks, logo, logoGlow, ring, history, scanRing, scanDisc, ghost, rail, railGlow, modules, floor: floorMesh, dust: dustPoints }

  all.reset = () => {
    for (const server of servers) {
      server.group.visible = false
      server.group.position.copy(server.home)
      server.group.scale.setScalar(1)
      for (const panel of server.panels) panel.reset()
      server.alert = false
    }
    for (const device of Object.values(devices)) { device.group.visible = false; device.group.rotation.set(0, 0, 0); device.group.scale.setScalar(1) }
    devices.laptop.hinge.rotation.x = -0.24
    for (const device of Object.values(devices)) device.screenGlow.material.opacity = 1
    for (const beam of beams) beam.reset()
    sparks.reset()
    logo.visible = false
    for (const card of history) card.visible = false
    scanRing.visible = scanDisc.visible = false
    ghost.visible = false
    rail.visible = railGlow.visible = false
    for (const module of modules) module.group.visible = false
    floorMesh.material.uniforms.uPulse.value = 0
    renderer.toneMappingExposure = 1.05
  }

  // Server lights: blink pattern and colour, as a pure function of time.
  all.animateServer = (server, t, { color = C.cyan, alert = false, intensity = 1 } = {}) => {
    server.leds.forEach(({ led, bar }, i) => {
      const on = Math.sin(t * (3 + i * 1.7) + i * 2.1) > -0.3
      led.material.color.set(alert && i % 2 === 0 ? C.red : color)
      led.material.color.multiplyScalar(on ? intensity : 0.25)
      bar.scale.x = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.9 + i * 1.3))
      bar.position.x = 0.2 - (1 - bar.scale.x) * 0.45
    })
    for (const strip of server.strips) strip.material.color.set(alert ? C.red : C.blue).multiplyScalar(intensity)
    server.cap.material.color.set(alert ? C.red : '#3b82f6')
    server.floorGlow.material.color.set(alert ? '#e11d48' : '#2563eb')
  }

  // offset shifts the framing horizontally (fraction of the width): positive puts the target right of centre.
  all.setCamera = (position, target, fov = 34, offset = 0) => {
    camera.position.set(...position)
    camera.fov = fov
    if (offset) camera.setViewOffset(1920, 1080, -offset * 1920, 0, 1920, 1080)
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
    camera.lookAt(...target)
    camera.updateMatrixWorld()
  }

  all.project = vector => {
    const v = vector.clone().project(camera)
    return { x: (v.x + 1) / 2 * 1920, y: (1 - v.y) / 2 * 1080, behind: v.z > 1 }
  }

  all.render = t => {
    dustPoints.rotation.y = t * 0.004
    dustPoints.position.y = Math.sin(t * 0.2) * 0.2
    sparks.apply()
    renderer.render(scene, camera)
  }
  return all
}
