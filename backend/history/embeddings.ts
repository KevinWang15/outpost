import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const embeddingModel = 'Xenova/multilingual-e5-small'
export const embeddingRevision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
export const embeddingDimensions = 384
export const embeddingIdentity = `${embeddingModel}@${embeddingRevision}:q8:mean:normalized:query-passage:v1`
export type Embed = (text: string, kind: 'query' | 'passage') => Promise<Float32Array>

/** One local model shared by accounts; conversation text never leaves Outpost. */
export function localEmbeddings(directory: string): Embed {
  let extractor: Promise<import('@huggingface/transformers').FeatureExtractionPipeline> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  return (text, kind) => {
    const result = queue.then(async () => {
      if (!extractor) {
        extractor = (async () => {
          const { env, pipeline } = await import('@huggingface/transformers')
          const cache = join(directory, 'history-models')
          mkdirSync(cache, { recursive: true, mode: 0o700 })
          env.cacheDir = cache
          env.allowLocalModels = false
          if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 2
          return pipeline('feature-extraction', embeddingModel, {
            revision: embeddingRevision,
            dtype: 'q8',
            device: 'cpu',
            session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
          })
        })()
        extractor.catch(() => {
          extractor = null
        })
      }
      const output = await (await extractor)(`${kind}: ${text}`, { pooling: 'mean', normalize: true })
      const vector = new Float32Array(output.data as Float32Array)
      if (vector.length !== embeddingDimensions || !vector.every(Number.isFinite))
        throw new Error('The local embedding model returned an invalid vector.')
      return vector
    })
    queue = result.catch(() => {})
    return result
  }
}
