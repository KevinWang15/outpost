// Generates the background score with ElevenLabs Music, with sections shaped
// to the measured narration timeline. Run after narrate.mjs.
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { elevenlabs } from './elevenlabs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timeline = JSON.parse(await readFile(resolve(root, 'assets/narration/timeline.json'), 'utf8'))
const at = id => timeline.scenes.find(scene => scene.id === id)
const ms = seconds => Math.round(seconds * 1000)
const total = ms(timeline.duration)
const bounds = [0, at('friction').start, at('reveal').start, at('create').start, at('search').start, at('architecture').start, timeline.duration].map(ms)
bounds[bounds.length - 1] = total

const shared = ['no vocals', 'no singing', 'no lyrics', 'no harsh distortion', 'no aggressive drops']
const sections = [
  ['Intro', ['sparse felt piano and soft analog pluck arpeggio', 'warm pad swell', 'curious and hopeful', 'very gentle, no drums']],
  ['Tension', ['same motif in a minor colour', 'muted pulsing bass', 'subtle ticking hi-hat', 'restrained, slightly unsettled']],
  ['Lift', ['bright major lift', 'kick and claps enter softly', 'rising synth arpeggio', 'optimistic resolution']],
  ['Groove A', ['steady mid-tempo electronic groove', 'warm rounded bass', 'light shuffled hats', 'airy plucks', 'unobtrusive background bed for voice-over']],
  ['Groove B', ['groove continues with small variation', 'gentle marimba-like plucks', 'light percussion', 'consistent energy, voice-over friendly']],
  ['Resolve', ['broad warm pads', 'groove thins out', 'confident uplifting ending', 'final chord rings out and fades to silence']],
].map(([section_name, positive_local_styles], i) => ({
  section_name, positive_local_styles, negative_local_styles: shared, duration_ms: bounds[i + 1] - bounds[i], lines: [],
}))

const plan = {
  positive_global_styles: ['modern minimal electronic', 'tech product launch film score', 'clean polished production', '108 bpm', 'D major', 'instrumental', 'warm and optimistic'],
  negative_global_styles: ['vocals', 'lyrics', 'heavy metal', 'dubstep', 'lo-fi hiss', 'cinematic trailer braams'],
  sections,
}
const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
const metaFile = resolve(root, 'assets/music/score.json')
const audioFile = resolve(root, 'assets/music/score.mp3')
const previous = await readFile(metaFile, 'utf8').then(JSON.parse).catch(() => null)
const audioExists = await stat(audioFile).then(info => info.isFile() && info.size > 0).catch(() => false)
if (audioExists && previous?.fingerprint === fingerprint && !process.argv.includes('--regenerate')) {
  console.log('Score is current; no request made.')
} else {
  console.log(`Composing ${(total / 1000).toFixed(1)} s score in ${sections.length} sections...`)
  const response = await elevenlabs('/v1/music?output_format=mp3_44100_128', { composition_plan: plan, model_id: 'music_v1', respect_sections_durations: true })
  const audio = Buffer.from(await response.arrayBuffer())
  await writeFile(audioFile, audio)
  await writeFile(metaFile, JSON.stringify({ provider: 'ElevenLabs Music', model: 'music_v1', songId: response.headers.get('song-id'), fingerprint, plan }, null, 1) + '\n')
  console.log(`Score saved (${(audio.length / 1e6).toFixed(1)} MB).`)
}
