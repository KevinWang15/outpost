import { useCallback, useRef, useState } from 'react'
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'

export const searchHighlightLimit = 1000
const decorations = {
  matchBackground: '#554617',
  matchBorder: '#a78b32',
  matchOverviewRuler: '#a78b32',
  activeMatchBackground: '#89661b',
  activeMatchBorder: '#facc15',
  activeMatchColorOverviewRuler: '#facc15',
}

/** Search only xterm's current buffer. No transport, PTY input or geometry changes. */
export function useTerminalSearch(restoreFocus: () => void) {
  const current = useRef<{ term: Terminal; addon: SearchAddon } | null>(null)
  const criteria = useRef({ query: '', caseSensitive: false, visible: false })
  const input = useRef<HTMLInputElement>(null)
  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState<ISearchResultChangeEvent>({ resultIndex: -1, resultCount: 0 })

  const find = useCallback((previous = false, incremental = false) => {
    const addon = current.current?.addon
    if (!addon) return
    const { query, caseSensitive } = criteria.current
    const options = { caseSensitive, incremental, decorations }
    if (previous) addon.findPrevious(query, options)
    else addon.findNext(query, options)
  }, [])

  const open = useCallback(() => {
    if (!current.current || current.current.term.element?.closest('[inert]')) return
    const wasVisible = criteria.current.visible
    criteria.current.visible = true
    setVisible(true)
    if (!wasVisible) find(false, true)
    // A mounted input needs explicit focus when Find is invoked again.
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [find])

  const close = useCallback(() => {
    criteria.current.visible = false
    current.current?.addon.clearDecorations()
    setVisible(false)
    restoreFocus()
  }, [restoreFocus])

  const attach = useCallback(
    (term: Terminal, container: HTMLElement) => {
      const addon = new SearchAddon({ highlightLimit: searchHighlightLimit })
      term.loadAddon(addon)
      current.current = { term, addon }
      const subscription = addon.onDidChangeResults(next => {
        setResults(previous =>
          previous.resultIndex === next.resultIndex && previous.resultCount === next.resultCount ? previous : next,
        )
      })
      const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const key = (event: KeyboardEvent) => {
        if (
          event.isComposing ||
          event.key.toLowerCase() !== 'f' ||
          event.altKey ||
          event.shiftKey ||
          (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
        )
          return
        // Capture before xterm can send Ctrl+F to the shell or the browser opens Find.
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'keydown') open()
      }
      container.addEventListener('keydown', key, true)
      container.addEventListener('keyup', key, true)
      if (criteria.current.visible) find(false, true)
      return () => {
        container.removeEventListener('keydown', key, true)
        container.removeEventListener('keyup', key, true)
        subscription.dispose()
        addon.dispose()
        current.current = null
      }
    },
    [find, open],
  )

  const changeQuery = (value: string) => {
    criteria.current.query = value
    setQuery(value)
    find(false, true)
  }
  const toggleCase = () => {
    criteria.current.caseSensitive = !criteria.current.caseSensitive
    setCaseSensitive(criteria.current.caseSensitive)
    // Invalidate cached highlights as well as the selected match when options change.
    current.current?.addon.clearDecorations()
    find(false, true)
    input.current?.focus({ preventScroll: true })
  }
  return { visible, query, caseSensitive, results, input, attach, open, close, find, changeQuery, toggleCase }
}
