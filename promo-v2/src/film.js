// Film runtime: mounts the 3D world and DOM scenes and renders any time t
// deterministically via window.renderFrame(t). The preview player drives the same function.
import timeline from '../assets/narration/timeline.json'
import { createWorld } from './world.js'
import { sceneFactories, shaded } from './scenes.js'
import { captionChunks } from './captions.js'
import { clamp, easeInOut, html, refs } from './util.js'

const exporting = new URLSearchParams(location.search).has('export')
document.body.classList.toggle('export', exporting)
const ASSET = '../assets/'

const stage = html(`<div class="stage">
  <canvas class="gl" width="1920" height="1080"></canvas>
  <div class="shade"></div>
  <div class="layer scenes"></div>
  <div class="vignette"></div>
  <canvas class="grain" width="480" height="270"></canvas>
  <div class="chapter"></div>
  <div class="captions"><div></div></div>
  <div class="flash"></div>
  <div class="dip"></div>
  <div class="progress"></div>
</div>`)
const frame = exporting ? stage : html('<div class="frame"></div>')
if (!exporting) frame.append(stage)
document.body.append(frame)

const world = createWorld(stage.querySelector('canvas.gl'))
const container = stage.querySelector('.scenes')
const scenes = timeline.scenes.map((measured, index) => {
  const cue = Object.fromEntries(Object.entries(measured.cues).map(([k, v]) => [k, v - measured.start]))
  const spec = sceneFactories[measured.id](cue)
  const el = html(`<div class="scene" data-scene="${measured.id}">${spec.markup}</div>`)
  container.append(el)
  // Everything starts hidden; scenes reveal what they need.
  for (const child of el.querySelectorAll('[data-r]')) if (child.parentElement === el) { child.style.opacity = 0; child.style.visibility = 'hidden' }
  return { ...measured, ...spec, index, el, r: refs(el), duration: measured.end - measured.start }
})
const chunks = captionChunks(timeline)
const caption = stage.querySelector('.captions div')
const chapter = stage.querySelector('.chapter')
const dip = stage.querySelector('.dip')
const flash = stage.querySelector('.flash')
const shade = stage.querySelector('.shade')
const progress = stage.querySelector('.progress')

// Static film grain, shifted per frame (deterministic).
const grain = stage.querySelector('canvas.grain')
{
  const ctx = grain.getContext('2d')
  const image = ctx.createImageData(480, 270)
  let seed = 99
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    const v = seed >>> 24
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v
    image.data[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  grain.style.width = '2000px'
  grain.style.height = '1160px'
}

let current = null
function renderFrame(t) {
  t = clamp(t, 0, timeline.duration - 1e-6)
  const scene = scenes.findLast(s => t >= s.start) ?? scenes[0]
  if (current !== scene) {
    for (const s of scenes) { s.el.style.display = s === scene ? 'block' : 'none'; s.el.style.visibility = 'visible' }
    current = scene
  }
  const local = t - scene.start
  world.reset()
  scene.update(local, world, scene.r)
  world.render(t)

  // Transitions: a short dip through black between scenes (skip into the first).
  const toEnd = scene.end - t
  const inT = scene.index === 0 ? 1 : clamp(local / 0.42)
  const outT = scene.index === scenes.length - 1 ? 1 : clamp(toEnd / 0.42)
  dip.style.opacity = 1 - easeInOut(Math.min(inT, outT))
  if (scene.index === scenes.length - 1) dip.style.opacity = clamp((t - (timeline.duration - 1.4)) / 1.4)
  if (scene.index === 0) dip.style.opacity = Math.max(Number(dip.style.opacity), 1 - clamp(t / 0.8))
  flash.style.opacity = 0
  shade.style.opacity = (shaded[scene.id] ?? 0) * clamp(local / 0.6)
  chapter.innerHTML = scene.chapter ? `<b>${String(scene.index + 1).padStart(2, '0')}</b>${scene.chapter}` : ''
  chapter.style.opacity = scene.chapter ? 0.9 * clamp((local - 0.5) / 0.6) * clamp(toEnd / 0.4) : 0

  const line = chunks.find(c => t >= c.start - 0.05 && t < c.until)
  caption.parentElement.style.opacity = line ? 1 : 0
  if (line) caption.textContent = line.text
  progress.style.width = `${(t / timeline.duration) * 100}%`
  grain.style.transform = `translate(${-((Math.floor(t * 24) * 37) % 40)}px, ${-((Math.floor(t * 24) * 23) % 40)}px)`
}

async function loadImages() {
  await document.fonts.ready
  await Promise.all(['400 20px Inter', '800 20px Inter', '400 20px "JetBrains Mono"', '700 20px "JetBrains Mono"'].map(f => document.fonts.load(f)))
  const load = src => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src })
  const logo = await load(`${ASSET}logo.svg`)
  world.logoTexture.update({ image: logo, src: logo.src })
  window.FILM_IMAGES = { dashboard: await load(`${ASSET}screenshots/dashboard.png`) }
  await Promise.all([...document.images].map(img => img.decode().catch(() => {})))
}

window.filmReady = loadImages().then(() => {
  window.renderFrame = renderFrame
  window.FILM = { duration: timeline.duration, fps: 30, scenes: scenes.map(({ id, start, end, chapter }) => ({ id, start, end, chapter })) }
  renderFrame(0)
  if (!exporting) mountPlayer()
  return true
})

function mountPlayer() {
  const fit = () => {
    const k = Math.min(innerWidth * 0.96, 1600) / 1920
    stage.style.transform = `scale(${k})`
    frame.style.width = `${1920 * k}px`
    frame.style.height = `${1080 * k}px`
  }
  fit()
  addEventListener('resize', fit)
  const bar = html(`<div class="player"><button data-play>Play</button><input type="range" min="0" max="${timeline.duration}" step="0.01" value="0"><span data-time>0:00</span><select data-jump><option value="">Jump to…</option>${scenes.map(s => `<option value="${s.start}">${s.index + 1}. ${s.chapter || 'Outro'}</option>`).join('')}</select></div>`)
  document.body.append(bar)
  const audio = new Audio('soundtrack.m4a')
  const seek = bar.querySelector('input')
  const label = bar.querySelector('[data-time]')
  const play = bar.querySelector('[data-play]')
  const params = new URLSearchParams(location.search)
  if (params.has('t')) audio.currentTime = Number(params.get('t'))
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const tick = () => {
    renderFrame(audio.currentTime)
    seek.value = audio.currentTime
    label.textContent = `${fmt(audio.currentTime)} / ${fmt(timeline.duration)}`
    if (!audio.paused) requestAnimationFrame(tick)
  }
  play.onclick = () => (audio.paused ? audio.play().then(tick) : audio.pause(), play.textContent = audio.paused ? 'Play' : 'Pause')
  audio.onpause = () => { play.textContent = 'Play' }
  seek.oninput = () => { audio.currentTime = Number(seek.value); tick() }
  bar.querySelector('[data-jump]').onchange = event => { if (event.target.value !== '') { audio.currentTime = Number(event.target.value); tick() } }
  renderFrame(audio.currentTime)
}
