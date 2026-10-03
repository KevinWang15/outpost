export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => a.map((v, i) => lerp(v, b[i], t))
export const easeOut = t => 1 - (1 - t) ** 3
export const easeIn = t => t * t * t
export const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2
export const springy = t => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-7 * t) * Math.cos(9 * t))

// 0 → 1 over [start, start + dur].
export const prog = (t, start, dur = 0.5) => clamp((t - start) / dur)
// Fades in at `a`, out at `b`.
export const win = (t, a, b, fadeIn = 0.45, fadeOut = 0.45) => clamp((t - a) / fadeIn) * (1 - clamp((t - (b - fadeOut)) / fadeOut))

export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// Interpolates a list of [time, ...values] keyframes with easeInOut.
export function track(keys, t) {
  if (t <= keys[0][0]) return keys[0].slice(1)
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, ...a] = keys[i - 1]
      const [t1, ...b] = keys[i]
      return mix3(a, b, easeInOut((t - t0) / (t1 - t0)))
    }
  }
  return keys.at(-1).slice(1)
}

export const typed = (text, t, start, cps = 20) => text.slice(0, Math.max(0, Math.floor((t - start) * cps)))

export function style(el, { o, x = 0, y = 0, s = 1, sx, sy, r = 0, rx = 0, ry = 0, z = 0, blur, origin } = {}) {
  if (o !== undefined) {
    el.style.opacity = o
    el.style.visibility = o <= 0.001 ? 'hidden' : 'visible'
  }
  el.style.transform = `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotate(${r}deg) scale(${sx ?? s}, ${sy ?? s})`
  if (blur !== undefined) el.style.filter = blur > 0.05 ? `blur(${blur}px)` : 'none'
  if (origin) el.style.transformOrigin = origin
}

export function html(markup) {
  const template = document.createElement('template')
  template.innerHTML = markup.trim()
  return template.content.firstElementChild
}

export const refs = root => Object.fromEntries([...root.querySelectorAll('[data-r]')].map(el => [el.dataset.r, el]))
