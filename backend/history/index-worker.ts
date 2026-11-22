import { parentPort, workerData } from 'node:worker_threads'
import { HistoryIndex } from './index'
import { request, respond, type IndexRequest } from './index-client'

const parent = parentPort!
let index: HistoryIndex | undefined
parent.on('message', ({ method, args, reply }: IndexRequest) => {
  void respond(reply, () => {
    if (method === 'close') return index?.close()
    index ??= new HistoryIndex(workerData.path, workerData.secret, (text, kind) => request(parent, { text, kind }))
    return Reflect.apply(index[method], index, args)
  })
})
