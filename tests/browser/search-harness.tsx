import { useCallback, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal, type IDecoration } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { TerminalRenderer } from '../../frontend/terminal/rendering'
import { useTerminalSearch } from '../../frontend/terminal/useTerminalSearch'
import TerminalSearch from '../../frontend/terminal/TerminalSearch'
import type { Checkpoint } from '../../shared/terminalState'

type Sample = ReturnType<typeof sample>
declare global {
  interface Window {
    terminalSearchFixture: {
      terminal: Terminal
      frames: Sample[]
      sample(): Sample
      output(text: string): Promise<void>
      restore(parts: Checkpoint[]): Promise<void>
      clear(): Promise<void>
    }
  }
}

// Inspect both the buffer and actual decoration positions on every render,
// rather than waiting for a stale highlight to eventually catch up.
function sample(term: Terminal) {
  type Decoration = IDecoration & { options: { x?: number; width?: number } }
  const core = (term as unknown as { _core: { _decorationService: { decorations: Iterable<Decoration> } } })._core
  const buffer = term.buffer.active
  const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
  const height = screen.getBoundingClientRect().height / term.rows
  return {
    viewport: buffer.viewportY,
    base: buffer.baseY,
    buffer: buffer.type,
    selection: term.getSelection(),
    lines: Array.from({ length: term.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true),
    ),
    highlights: [...core._decorationService.decorations]
      .filter(decoration => !decoration.marker.isDisposed)
      .map(decoration => {
        const row = decoration.marker.line
        const column = decoration.options.x ?? 0
        const width = decoration.options.width ?? 1
        return {
          row,
          column,
          width,
          text: buffer.getLine(row)?.translateToString(false, column, column + width),
          visible: !!decoration.element && decoration.element.style.display !== 'none',
          top: decoration.element ? parseFloat(decoration.element.style.top) : null,
          expectedTop: (row - buffer.viewportY) * height,
        }
      }),
  }
}

function Harness() {
  const surface = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const focus = useCallback(() => terminal.current?.focus(), [])
  const search = useTerminalSearch(focus)
  const { attach, bufferChanged } = search
  useLayoutEffect(() => {
    const options = new URLSearchParams(location.search)
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 10_000, cursorBlink: false })
    terminal.current = term
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(surface.current!)
    const detach = attach(term, container.current!)
    if (options.has('gpu')) term.loadAddon(new WebglAddon())
    const renderer = new TerminalRenderer(
      term,
      message => {
        throw new Error(message)
      },
      !options.has('remote'),
      bufferChanged,
    )
    renderer.begin()
    const frames: Sample[] = []
    const rendered = term.onRender(() =>
      queueMicrotask(() => {
        // xterm forwards its public render event before its decoration listener.
        // Inspect after all synchronous render listeners, still before paint.
        if (frames.length < 500) frames.push(sample(term))
      }),
    )
    window.terminalSearchFixture = {
      terminal: term,
      frames,
      sample: () => sample(term),
      output: text => new Promise(resolve => renderer.output(new TextEncoder().encode(text), resolve)),
      restore: parts =>
        new Promise(resolve => {
          renderer.begin()
          for (const checkpoint of parts) renderer.restore({ type: 'restore', checkpoint }, () => {})
          renderer.flush(resolve)
        }),
      clear: () => new Promise(resolve => renderer.restore({ type: 'clear' }, resolve)),
    }
    return () => {
      rendered.dispose()
      renderer.dispose()
      detach()
      term.dispose()
      terminal.current = null
    }
  }, [attach, bufferChanged])
  return (
    <div ref={container} style={{ position: 'relative', width: 1000, height: 600 }}>
      <div ref={surface} />
      {search.visible && <TerminalSearch search={search} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
