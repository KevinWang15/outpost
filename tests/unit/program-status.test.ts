// OSC 7501 Program Status Protocol tests, matching Ghostty's canonical spec.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractProgramStatus,
  formatProgramStatusReply,
  formatProgramStatusReport,
  parseProgramStatus,
  processProgramStatus,
  programStatusLimits,
  programStatusQueryReply,
} from '../../shared/programStatus'

test('OSC 7501: query and query reply', () => {
  assert.deepEqual(parseProgramStatus('?', 'st'), { kind: 'query', terminator: 'st' })
  assert.deepEqual(parseProgramStatus('?', 'bel'), { kind: 'query', terminator: 'bel' })
  assert.equal(programStatusQueryReply, '?:states=idle,working,done,blocked,error:kinds=permission,question,auth')
  assert.equal(
    formatProgramStatusReply('st'),
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\',
  )
  assert.equal(
    formatProgramStatusReply('bel'),
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x07',
  )
})

test('OSC 7501: minimal report and all keys', () => {
  assert.deepEqual(parseProgramStatus('state=idle'), {
    kind: 'report',
    report: { state: 'idle', id: null, app: null, kind: null, progress: null, title: null, msg: null },
  })
  assert.deepEqual(
    parseProgramStatus(
      'state=blocked:kind=permission:progress=42:id=tf/plan:app=terraform' +
        ':title=UGxhbg==:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/',
    ),
    {
      kind: 'report',
      report: {
        state: 'blocked',
        id: 'tf/plan',
        app: 'terraform',
        kind: 'permission',
        progress: 42,
        title: 'Plan',
        msg: 'Apply 3 to add, 1 to change, 0 to destroy?',
      },
    },
  )
})

test('OSC 7501: optional base64 padding, whitespace, last-value-wins, and forgiving pairs', () => {
  const unpadded = parseProgramStatus('state=done:msg=UGxhbg')
  assert.equal(unpadded?.kind === 'report' ? unpadded.report.msg : null, 'Plan')

  const spaced = parseProgramStatus(' state = working :\tapp=cargo\t')
  assert.deepEqual(spaced, {
    kind: 'report',
    report: { state: 'working', id: null, app: 'cargo', kind: null, progress: null, title: null, msg: null },
  })

  const overridden = parseProgramStatus('state=idle:app=a:state=done:app=b')
  assert.deepEqual(overridden, {
    kind: 'report',
    report: { state: 'done', id: null, app: 'b', kind: null, progress: null, title: null, msg: null },
  })

  const forgiving = parseProgramStatus('garbage:=x:Bad=1:app=b@d:future=yes:state=working:app=ok:::')
  assert.deepEqual(forgiving, {
    kind: 'report',
    report: { state: 'working', id: null, app: 'ok', kind: null, progress: null, title: null, msg: null },
  })

  const emptyText = parseProgramStatus('state=done:msg=:title=')
  assert.deepEqual(emptyText, {
    kind: 'report',
    report: { state: 'done', id: null, app: null, kind: null, progress: null, title: null, msg: null },
  })
})

test('OSC 7501: kind, progress, and app scoping rules', () => {
  const working = parseProgramStatus('state=working:kind=auth:progress=10')
  assert.equal(working?.kind === 'report' ? working.report.kind : 'bad', null)
  assert.equal(working?.kind === 'report' ? working.report.progress : 'bad', 10)

  const done = parseProgramStatus('state=done:kind=auth:progress=10')
  assert.equal(done?.kind === 'report' ? done.report.kind : 'bad', null)
  assert.equal(done?.kind === 'report' ? done.report.progress : 'bad', null)

  const unknownKind = parseProgramStatus('state=blocked:kind=dance')
  assert.equal(unknownKind?.kind === 'report' ? unknownKind.report.kind : 'bad', null)

  const invalidApp = parseProgramStatus('state=idle:app=a/b')
  assert.equal(invalidApp?.kind === 'report' ? invalidApp.report.app : 'bad', null)

  const progressCases: [string, number | null][] = [
    ['0', 0],
    ['100', 100],
    ['101', null],
    ['256', null],
    ['99999999999999999999', null],
    ['-1', null],
    ['+1', null],
    ['4.5', null],
    ['1_0', null],
    ['007', 7],
    ['', null],
  ]
  for (const [raw, expected] of progressCases) {
    const parsed = parseProgramStatus(`state=working:progress=${raw}`)
    assert.equal(parsed?.kind === 'report' ? parsed.report.progress : 'bad', expected, raw)
  }
})

test('OSC 7501: id validation discards the entire report on any invalid id', () => {
  const maxSegment = 'a'.repeat(programStatusLimits.maxIdSegmentBytes)
  for (const id of ['a', 'build/test', 'A-Z_0.9+', maxSegment, 'a/b/c/d/e/f/g/h']) {
    const parsed = parseProgramStatus(`state=clear:id=${id}`)
    assert.equal(parsed?.kind === 'report' ? parsed.report.id : null, id, id)
  }

  const maxTotal = `${'a'.repeat(31)}/`.repeat(4).slice(0, 127) + 'b' // 128 bytes
  assert.equal(parseProgramStatus(`state=clear:id=${maxTotal}`)?.kind, 'report')

  const invalid = [
    '',
    '/',
    'a/',
    '/a',
    'a//b',
    'a,b',
    'a=b',
    'a@b',
    'a b',
    'a%20b',
    `${maxSegment}a`,
    'a/b/c/d/e/f/g/h/i',
    `${'a'.repeat(31)}/`.repeat(4) + 'a', // 129 bytes
  ]
  for (const id of invalid) {
    assert.equal(parseProgramStatus(`state=clear:id=${id}`), null, id)
    // An invalid id is never replaced by a later valid one.
    assert.equal(parseProgramStatus(`state=clear:id=${id}:id=a`), null, `overridden ${id}`)
  }
})

test('OSC 7501: base64 text validation rejects invalid base64, unsafe UTF-8, and control chars', () => {
  const invalid = [
    'state=done:msg=a',
    'state=done:msg=QQ=',
    'state=done:title=a',
    'state=done:msg=AB==', // non-canonical trailing bits
    'state=done:msg=ABC=', // non-canonical trailing bits
    'state=done:msg=YQpi', // "a\nb" (C0 control)
    'state=done:msg=fw==', // DEL (0x7f)
    'state=done:msg=wps=', // "\x9b" (C1 control as UTF-8)
    'state=done:msg=/w==', // invalid UTF-8
  ]
  for (const body of invalid) assert.equal(parseProgramStatus(body), null, body)

  // Valid Unicode: "安全"
  const unicode = parseProgramStatus('state=done:msg=5a6J5YWo')
  assert.equal(unicode?.kind === 'report' ? unicode.report.msg : null, '安全')
})

test('OSC 7501: size limits apply strictly across keys, values, and whole sequences', () => {
  const title192 = 'QUFB'.repeat(programStatusLimits.maxTitleBytes / 3) // 192 bytes decoded, 256 encoded
  const main2046 = 'QUFB'.repeat(Math.floor(programStatusLimits.maxMsgBytes / 3)) // 2046 bytes decoded
  const msg2048 = `${main2046}QUE` // 2048 bytes decoded
  const fill = programStatusLimits.maxSequenceBytes - '\x1b]7501;state=idle:'.length - '\x1b\\'.length

  const cases: [string, boolean][] = [
    ['', false],
    ['app=cargo', false],
    ['state=sleeping', false],
    ['state=', false],
    ['state=IDLE', false],
    [`state=idle:${'a'.repeat(programStatusLimits.maxKeyBytes)}=1`, true],
    [`state=idle:${'a'.repeat(programStatusLimits.maxKeyBytes + 1)}=1`, false],
    [`state=idle:app=${'a'.repeat(programStatusLimits.maxAppBytes + 1)}`, false],
    [`state=idle:app=${'a'.repeat(programStatusLimits.maxAppBytes + 1)}:app=ok`, false],
    // Limits apply even to values with disallowed bytes.
    [`state=idle:app=@${'a'.repeat(programStatusLimits.maxAppBytes)}`, false],
    [`state=idle:title=${title192}`, true],
    [`state=idle:title=${title192}QUFB`, false],
    [`state=idle:msg=${msg2048}`, true],
    [`state=idle:msg=${main2046}QUFB`, false],
    [`state=idle:${'x'.repeat(fill)}`, true],
    [`state=idle:${'x'.repeat(fill + 1)}`, false],
  ]
  for (const [body, ok] of cases) assert.equal(parseProgramStatus(body) !== null, ok, body.slice(0, 60))
})

test('OSC 7501: stream extractor preserves query/DA1 order, strips 7501, and leaves other escapes untouched', () => {
  const events: string[] = []
  processProgramStatus('hello\x1b[?u\x1b]7501;?\x1b\\\x1b[cworld', {
    output: text => events.push(`out:${text}`),
    reply: seq => events.push(`reply:${seq}`),
    report: r => events.push(`report:${r.state}`),
  })
  assert.deepEqual(events, ['out:hello\x1b[?u', `reply:${formatProgramStatusReply('st')}`, 'out:\x1b[cworld'])

  // BEL query, ST report, C1 8-bit report, and unrelated OSC/DCS sequences.
  const formatted = formatProgramStatusReport({
    state: 'blocked',
    app: 'claude-code',
    kind: 'question',
    progress: 75,
    title: 'Confirm',
    msg: 'Deploy 安全?',
  })
  const chunk =
    '\x1b]0;7501;state=working\x07' + // window title containing literal "7501;" — untouched!
    '\x1b]75010;state=working\x1b\\' + // different OSC number — untouched!
    '\x1bP7501;state=error\x1b\\' + // DCS containing "7501;" — untouched!
    '\x1b]7501;?\x07' + // BEL query
    formatted + // valid report
    '\x9d7501;state=done:app=codex\x9c' + // C1 8-bit OSC/ST
    '\x1b]7501;state=working\x1b[32mvisible' // aborted OSC 7501 followed by CSI — CSI preserved!

  const extracted = extractProgramStatus(chunk)
  assert.equal(
    extracted.output,
    '\x1b]0;7501;state=working\x07\x1b]75010;state=working\x1b\\\x1bP7501;state=error\x1b\\\x1b]7501;state=working\x1b[32mvisible',
  )
  assert.deepEqual(extracted.replies, [formatProgramStatusReply('bel')])
  assert.deepEqual(extracted.reports, [
    {
      state: 'blocked',
      id: null,
      app: 'claude-code',
      kind: 'question',
      progress: 75,
      title: 'Confirm',
      msg: 'Deploy 安全?',
    },
    {
      state: 'done',
      id: null,
      app: 'codex',
      kind: null,
      progress: null,
      title: null,
      msg: null,
    },
  ])
})
