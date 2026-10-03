// Records one narration take per scene (cached by fingerprint) and writes the
// measured timeline that drives every animation cue in the film.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { elevenlabs } from './elevenlabs.mjs'
import { narrator, scenes } from './script.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(root, 'assets/narration')
const modelId = 'eleven_multilingual_v2'
const settings = { stability: 0.5, similarity_boost: 0.8, style: 0.22, use_speaker_boost: true, speed: 1.0 }
const leadIn = 0.55
const hash = value => createHash('sha256').update(value).digest('hex')
const frameRound = value => Math.ceil(value * 30) / 30

await mkdir(dir, { recursive: true })
const timeline = []
let position = 0
for (const [i, scene] of scenes.entries()) {
  const previous = scenes[i - 1]?.text ?? ''
  const next = scenes[i + 1]?.text ?? ''
  const fingerprint = hash(JSON.stringify({ text: scene.text, previous, next, voice: narrator.id, modelId, settings }))
  const takeFile = resolve(dir, `${scene.id}.json`)
  const audioFile = resolve(dir, `${scene.id}.mp3`)
  let take
  try { take = JSON.parse(await readFile(takeFile, 'utf8')) } catch { /* not recorded yet */ }
  const audioMatches = await readFile(audioFile).then(audio => hash(audio) === take?.audioSha256).catch(() => false)
  if (!audioMatches || take?.fingerprint !== fingerprint || process.argv.includes('--regenerate')) {
    console.log(`Recording ${scene.id} (${scene.text.length} characters)`)
    const response = await elevenlabs(`/v1/text-to-speech/${narrator.id}/with-timestamps?output_format=mp3_44100_128`, {
      text: scene.text, model_id: modelId, voice_settings: settings, previous_text: previous, next_text: next, seed: 4242,
    })
    const result = await response.json()
    if (result.alignment.characters.join('') !== scene.text) throw new Error(`Alignment mismatch in ${scene.id}`)
    const audio = Buffer.from(result.audio_base64, 'base64')
    take = { voice: narrator.name, voiceId: narrator.id, modelId, settings, text: scene.text, fingerprint, alignment: result.alignment, audioSha256: hash(audio) }
    await writeFile(audioFile, audio)
    await writeFile(takeFile, JSON.stringify(take, null, 1) + '\n')
  } else console.log(`Reusing ${scene.id}`)

  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = take.alignment
  const visible = characters.map((c, k) => (/\S/.test(c) ? k : -1)).filter(k => k >= 0)
  const offset = position + leadIn
  const speechStart = offset + starts[visible[0]]
  const speechEnd = offset + ends[visible.at(-1)]
  const end = frameRound(speechEnd + scene.hold)
  const cues = Object.fromEntries(Object.entries(scene.cues).map(([name, phrase]) => {
    const at = scene.text.indexOf(phrase)
    if (at < 0) throw new Error(`Cue phrase not found: ${scene.id}.${name}`)
    return [name, offset + starts[at]]
  }))
  // Word timings for captions.
  const words = []
  for (const match of scene.text.matchAll(/\S+/g)) {
    words.push({ text: match[0], start: offset + starts[match.index], end: offset + ends[match.index + match[0].length - 1] })
  }
  timeline.push({ id: scene.id, start: position, end, audioOffset: offset, speechStart, speechEnd, cues, words, audio: `${scene.id}.mp3` })
  position = end
}
await writeFile(resolve(dir, 'timeline.json'), JSON.stringify({ narrator: narrator.name, modelId, fps: 30, duration: position, scenes: timeline }, null, 1) + '\n')
console.log(`Timeline: ${position.toFixed(2)} s across ${timeline.length} scenes`)
