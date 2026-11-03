import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { IMarker, Terminal } from '@xterm/xterm'

interface LineCache {
  _linesCache?: unknown[]
  _linesCacheDisposables: { clear(): void }
  initLinesCache(): void
  _destroyLinesCache(): void
}

/** The addon uses three selection methods as its navigation cursor. Give those
 * methods private, marker-backed state so search never reads or writes the
 * terminal's user selection. All other operations use the real terminal. */
function searchTerminal(terminal: Terminal) {
  let match: { marker: IMarker; column: number; length: number; cols: number } | undefined
  const clearSelection = () => {
    match?.marker.dispose()
    match = undefined
  }
  const selection = {
    clearSelection,
    select(column: number, row: number, length: number) {
      clearSelection()
      const buffer = terminal.buffer.active
      const marker = terminal.registerMarker(row - buffer.baseY - buffer.cursorY)
      if (marker) match = { marker, column, length, cols: terminal.cols }
    },
    getSelectionPosition() {
      // A resize can reflow columns; a buffer switch or trimmed marker can
      // invalidate the old match. Restart navigation rather than use stale cells.
      if (!match || match.marker.isDisposed || match.cols !== terminal.cols) {
        clearSelection()
        return undefined
      }
      const { marker, column, length, cols } = match
      const lastCell = column + length - 1
      return {
        start: { x: column, y: marker.line },
        end: { x: (lastCell % cols) + 1, y: marker.line + Math.floor(lastCell / cols) },
      }
    },
  }
  const buffer = terminal.buffer.onBufferChange(clearSelection)
  const view = new Proxy(terminal, {
    get(target, key) {
      if (key === 'select' || key === 'clearSelection' || key === 'getSelectionPosition') return selection[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    view,
    dispose() {
      buffer.dispose()
      clearSelection()
    },
  }
}

class BufferSearchAddon extends SearchAddon {
  private navigation?: ReturnType<typeof searchTerminal>

  override activate(terminal: Terminal) {
    this.navigation = searchTerminal(terminal)
    super.activate(this.navigation.view)
  }

  override dispose() {
    super.dispose()
    this.navigation?.dispose()
  }
}

/** The narrow adapter surface for @xterm/addon-search 0.16.0. Its public API
 * cannot invalidate cached text or refresh without scrolling. Keep that
 * dependency here until the addon exposes a synchronous refresh API. */
interface LiveSearch extends SearchAddon {
  _updateMatches(): void
  _lineCache: { value: LineCache }
  _state: {
    cachedSearchTerm?: string
    lastSearchOptions?: ISearchOptions
    clearCachedTerm(): void
  }
  findPrevious(term: string, options?: ISearchOptions, internal?: { noScroll: boolean }): boolean
}

/** Preserve xterm's matching, Unicode handling and marker-based scrolling.
 * Refresh decorations in the same parse/render cycle as the text, including
 * redraws which restore the cursor and therefore emit no cursor-move event.
 * onWriteParsed is already coalesced by xterm; a trailing debounce can starve
 * highlights indefinitely while a TUI is producing output. */
export function liveSearchAddon(terminal: Terminal, highlightLimit: number) {
  const addon = new BufferSearchAddon({ highlightLimit })
  terminal.loadAddon(addon)
  const live = addon as LiveSearch
  if (
    typeof live._updateMatches !== 'function' ||
    typeof live._lineCache?.value?._destroyLinesCache !== 'function' ||
    typeof live._lineCache?.value?.initLinesCache !== 'function' ||
    typeof live._lineCache?.value?._linesCacheDisposables?.clear !== 'function' ||
    typeof live._state?.clearCachedTerm !== 'function'
  ) {
    addon.dispose()
    throw new Error('Unsupported xterm search addon; update the live search adapter')
  }
  const cache = live._lineCache.value
  const initialize = cache.initLinesCache.bind(cache)
  cache.initLinesCache = () => {
    initialize()
    // This adapter owns invalidation after parsing. Cursor/line-feed listeners
    // otherwise discard immutable history as well as the mutable screen.
    cache._linesCacheDisposables.clear()
  }
  let history: { type: string; cols: number; rows: number; base: number; anchor?: IMarker } | undefined
  const invalidate = () => {
    const buffer = terminal.buffer.active
    const stable =
      history &&
      history.type === buffer.type &&
      history.cols === terminal.cols &&
      history.rows === terminal.rows &&
      buffer.baseY >= history.base &&
      (history.base === 0 || (history.anchor && !history.anchor.isDisposed && history.anchor.line === history.base - 1))
    if (cache._linesCache && stable) {
      // Screen rows can be rewritten arbitrarily. Include a logical line which
      // starts in history and wraps onto the screen. A marker in history detects
      // trimming even when a full 10,000-line buffer keeps the same baseY.
      let first = history!.base
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--
      cache._linesCache.fill(undefined, first)
      cache._linesCache.length = buffer.length
    } else cache._destroyLinesCache()
    if (!stable || history!.base !== buffer.baseY) {
      history?.anchor?.dispose()
      history = {
        type: buffer.type,
        cols: terminal.cols,
        rows: terminal.rows,
        base: buffer.baseY,
        anchor: buffer.baseY > 0 ? terminal.registerMarker(-buffer.cursorY - 1) : undefined,
      }
    }
  }
  // The addon's write/resize subscriptions call this method. Replace its 200 ms
  // debounce at the source, rather than racing another refresh against it.
  let frame = 0
  let disposed = false
  live._updateMatches = () => {
    if (disposed) return
    invalidate()
    const query = live._state.cachedSearchTerm
    const options = live._state.lastSearchOptions
    if (!query || !options?.decorations) return
    // A remote synchronized redraw may span packets. Keep the old highlights
    // with the old painted text until xterm releases the frame. Checking rAF
    // also covers xterm's safety timeout when an application omits the end code.
    if (terminal.modes.synchronizedOutputMode) {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          live._updateMatches()
        })
      return
    }
    cancelAnimationFrame(frame)
    frame = 0
    live._state.clearCachedTerm()
    live.findPrevious(query, { ...options, incremental: true }, { noScroll: true })
  }
  return {
    addon,
    refresh: () => {
      cache._destroyLinesCache()
      live._updateMatches()
    },
    dispose: () => {
      disposed = true
      cancelAnimationFrame(frame)
      history?.anchor?.dispose()
      addon.dispose()
    },
  }
}
