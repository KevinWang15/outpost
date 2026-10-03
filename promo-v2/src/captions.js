// Splits measured narration words into short caption phrases.
// Shared by the in-picture captions and the exported SRT track.
const MAX = 50
const join = words => words.map(w => w.text).join(' ')

// Splits a sentence at the most central comma (or, failing that, the most central word) until each part fits.
function split(words) {
  if (join(words).length <= MAX) return [words]
  const total = join(words).length
  let best = -1
  let bestScore = Infinity
  for (let i = 1; i < words.length; i++) {
    const left = join(words.slice(0, i)).length
    const comma = /[,;:]$/.test(words[i - 1].text)
    const score = Math.abs(left - total / 2) - (comma ? 14 : 0)
    if (score < bestScore && left > 8 && total - left > 8) { bestScore = score; best = i }
  }
  return [...split(words.slice(0, best)), ...split(words.slice(best))]
}

export function captionChunks(timeline) {
  const chunks = []
  for (const scene of timeline.scenes) {
    let sentence = []
    const flush = () => {
      for (const part of split(sentence)) chunks.push({ scene: scene.id, text: join(part), start: part[0].start, end: part.at(-1).end })
      sentence = []
    }
    for (const word of scene.words) {
      sentence.push(word)
      if (/[.?!]$/.test(word.text)) flush()
    }
    if (sentence.length) flush()
  }
  // Each phrase stays up until the next one begins (bounded so silences read as silence).
  return chunks.map((chunk, i) => ({ ...chunk, until: Math.min(chunks[i + 1]?.start ?? Infinity, chunk.end + 0.7) }))
}

const stamp = s => {
  const ms = Math.round(s * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}
export const toSrt = chunks => chunks.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.until)}\n${c.text}\n`).join('\n')
