/* global window */
// Builds the film page, mixes the soundtrack, and exports a 1920×1080 30 fps MP4.
//   node scripts/render.mjs            full render
//   node scripts/render.mjs --stills   one still per scene (plus --at=12.5,40 for specific times)
//   node scripts/render.mjs --preview  serve the interactive player
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { captionChunks, toSrt } from '../src/captions.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'output')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const timeline = JSON.parse(await readFile(resolve(root, 'assets/narration/timeline.json'), 'utf8'))
const FPS = 30

function run(cmd, argv, { stdin = false } = {}) {
  const child = spawn(cmd, argv, { stdio: [stdin ? 'pipe' : 'ignore', 'inherit', 'pipe'] })
  let err = ''
  child.stderr.on('data', d => { err = (err + d).slice(-8000) })
  const done = new Promise((ok, fail) => child.on('close', code => (code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}\n${err}`)))))
  done.catch(() => {})
  return { child, done }
}

async function buildPage() {
  await copyFile(resolve(root, '../public/outpost.svg'), resolve(root, 'assets/logo.svg'))
  const result = await build({ entryPoints: [resolve(root, 'src/film.js')], bundle: true, write: false, format: 'iife', target: 'chrome120', loader: { '.json': 'json' }, minify: true, legalComments: 'none' })
  const css = await readFile(resolve(root, 'src/film.css'), 'utf8')
  const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script')
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outpost — AI Session Manager</title><style>${css}</style></head><body><script>${js}</script></body></html>`
  await writeFile(resolve(out, 'film.html'), page)
}

// Narration placed on the measured timeline, music ducked beneath it, then mastered.
async function mixAudio() {
  const voices = timeline.scenes.map(s => ({ file: resolve(root, 'assets/narration', s.audio), delay: Math.round(s.audioOffset * 1000) }))
  try {
    await Promise.all([...voices.map(voice => voice.file), resolve(root, 'assets/music/score.mp3')].map(file => access(file)))
  } catch {
    throw new Error('Generated audio is missing. In promo-v2, run npm run narrate and npm run music with your own ELEVENLABS_API_KEY before previewing or exporting a movie.')
  }
  const inputs = voices.flatMap(v => ['-i', v.file])
  const voiceChains = voices.map((v, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${v.delay}|${v.delay}[v${i}]`).join(';')
  const music = voices.length
  const D = timeline.duration.toFixed(3)
  const filter = [
    voiceChains,
    `${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${voices.length}:normalize=0,apad,atrim=0:${D},loudnorm=I=-16:TP=-2:LRA=9,asplit=2[voice][key]`,
    `[${music}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${D},volume=-17dB,afade=t=in:d=1.2,afade=t=out:st=${(timeline.duration - 3).toFixed(2)}:d=3[bed]`,
    `[bed][key]sidechaincompress=threshold=0.02:ratio=5:attack=40:release=650:makeup=1[ducked]`,
    `[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.89:level=false[out]`,
  ].join(';')
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-i', resolve(root, 'assets/music/score.mp3'), '-filter_complex', filter, '-map', '[out]', '-c:a', 'aac', '-b:a', '256k', '-t', D, resolve(out, 'soundtrack.m4a')]).done
}

function serve(port = 0) {
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json', '.mp4': 'video/mp4' }
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = resolve(root, `.${path === '/' ? '/output/film.html' : path}`)
    try {
      if (!file.startsWith(root + sep)) throw new Error('outside')
      const info = await stat(file)
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size })
      createReadStream(file).pipe(res)
    } catch { res.writeHead(404).end() }
  })
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })))
}

async function openFilm(origin) {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`${origin}/output/film.html?export=1`)
  await page.evaluate(() => window.filmReady)
  if (errors.length) throw new Error(`Film page errors:\n${errors.join('\n')}`)
  return { browser, page, errors }
}

await mkdir(out, { recursive: true })
await buildPage()
await writeFile(resolve(out, 'captions.srt'), toSrt(captionChunks(timeline)))

if (flag('preview')) {
  await mixAudio()
  const { origin } = await serve(Number(process.env.PORT ?? 4300))
  console.log(`Preview: ${origin}/output/film.html`)
} else if (flag('stills')) {
  const { server, origin } = await serve()
  const { browser, page, errors } = await openFilm(origin)
  const dir = resolve(out, 'stills')
  await mkdir(dir, { recursive: true })
  const times = option('at') ? option('at').split(',').map(Number) : timeline.scenes.map(s => s.start + (s.end - s.start) * 0.62)
  for (const t of times) {
    await page.evaluate(time => window.renderFrame(time), t)
    await page.screenshot({ path: resolve(dir, `t${t.toFixed(2).padStart(7, '0')}.png`) })
  }
  if (errors.length) console.error(errors.join('\n'))
  console.log(`Saved ${times.length} stills to ${dir}`)
  await browser.close()
  server.close()
} else {
  await mixAudio()
  const { server, origin } = await serve()
  const from = Number(option('from') ?? 0)
  const to = Number(option('to') ?? timeline.duration)
  const total = Math.round((to - from) * FPS)
  const workers = Number(option('workers') ?? 6)
  const per = Math.ceil(total / workers)
  const started = Date.now()
  let rendered = 0
  // Each worker renders a contiguous frame range into its own H.264 part; parts are concatenated losslessly.
  const parts = await Promise.all(Array.from({ length: workers }, async (_, k) => {
    const first = k * per
    const count = Math.max(0, Math.min(per, total - first))
    const part = resolve(out, `part-${k}.mp4`)
    if (!count) return null
    const { browser, page, errors } = await openFilm(origin)
    const encoder = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '12M', '-bufsize', '24M', '-tune', 'film', '-pix_fmt', 'yuv420p', '-threads', '2', part], { stdin: true })
    for (let f = first; f < first + count; f++) {
      await page.evaluate(time => window.renderFrame(time), from + f / FPS)
      const jpg = await page.screenshot({ type: 'jpeg', quality: 95 })
      if (!encoder.child.stdin.write(jpg)) await once(encoder.child.stdin, 'drain')
      if (++rendered % 300 === 0) {
        const rate = rendered / ((Date.now() - started) / 1000)
        console.log(`${rendered}/${total} frames  ${rate.toFixed(1)} fps  eta ${Math.round((total - rendered) / rate)} s`)
      }
    }
    encoder.child.stdin.end()
    await encoder.done
    if (errors.length) throw new Error(errors.join('\n'))
    await browser.close()
    return part
  }))
  server.close()
  const list = resolve(out, 'parts.txt')
  await writeFile(list, parts.filter(Boolean).map(p => `file '${p}'`).join('\n') + '\n')
  const picture = resolve(out, 'picture.mp4')
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]).done
  for (const p of parts.filter(Boolean)) await rm(p)
  await rm(list)
  const movie = resolve(out, from === 0 && to === timeline.duration ? 'outpost-promo-v2.mp4' : 'segment.mp4')
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', picture, '-ss', String(from), '-t', String(to - from), '-i', resolve(out, 'soundtrack.m4a'), '-i', resolve(out, 'captions.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
    '-metadata', 'title=Outpost — AI Session Manager. Keep the session. Keep your flow.', '-t', String(to - from), '-movflags', '+faststart', movie]).done
  await rm(picture)
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s: ${movie}`)
}
