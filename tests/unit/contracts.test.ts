// Contracts between Outpost's server and the code it runs on machines.
import assert from 'node:assert/strict'
import test from 'node:test'
import { harnessIds } from '../../shared/harnesses'
import historyTools from '../../shared/historyTools.json' with { type: 'json' }
import { FrameDecoder, terminalFrame, terminalControl } from '../../shared/node/terminalFrames'
import { allHarnesses } from '../../machine/harnesses'

test('every registered coding harness has a machine adapter', () => {
  assert.deepEqual(
    allHarnesses().map(harness => harness.id),
    harnessIds,
  )
})

test('history MCP advertises every registered coding harness', () => {
  const search = historyTools.find(tool => tool.name === 'search_history')!
  assert.deepEqual(search.inputSchema.properties.tool!.enum, harnessIds)
})

test('frames decode identically however the bytes are split', () => {
  const frames = Buffer.concat([
    terminalFrame('I', Buffer.from([0, 1, 255])),
    terminalControl({ type: 'resize', cols: 80, rows: 24 }),
    terminalFrame('D', Buffer.from([0, 0, 0, 7, 27])),
  ])
  const decoder = new FrameDecoder()
  const decoded = []
  for (let index = 0; index < frames.length; index++) decoded.push(...decoder.feed(frames.subarray(index, index + 1)))
  assert.deepEqual(
    decoded.map(frame => [frame.kind, [...frame.payload]]),
    [
      ['I', [0, 1, 255]],
      ['C', [...Buffer.from('{"type":"resize","cols":80,"rows":24}')]],
      ['D', [0, 0, 0, 7, 27]],
    ],
  )
})
