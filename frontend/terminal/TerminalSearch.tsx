import { useLayoutEffect } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { searchHighlightLimit, type useTerminalSearch } from './useTerminalSearch'

export default function TerminalSearch({ search }: { search: ReturnType<typeof useTerminalSearch> }) {
  const { input, query, results } = search
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [input])
  const count = !query
    ? ''
    : results.resultCount === 0
      ? 'No results'
      : results.resultCount >= searchHighlightLimit
        ? `${searchHighlightLimit}+ matches`
        : results.resultIndex < 0
          ? `${results.resultCount} matches`
          : `${results.resultIndex + 1} of ${results.resultCount}`

  return (
    <div
      className="terminal-search"
      role="search"
      aria-label="Find in terminal"
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          search.close()
        } else if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault()
          event.stopPropagation()
          search.find(event.shiftKey)
        }
      }}
    >
      <Search size={16} aria-hidden="true" />
      <input
        ref={input}
        type="text"
        aria-label="Find in terminal"
        placeholder="Find in terminal…"
        value={query}
        onChange={event => search.changeQuery(event.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      <span className="terminal-search-count" role="status" aria-live="polite" aria-atomic="true">
        {count}
      </span>
      <button
        className="icon-button terminal-search-case"
        title="Match case"
        aria-label="Match case"
        aria-pressed={search.caseSensitive}
        onClick={search.toggleCase}
      >
        <CaseSensitive size={17} />
      </button>
      <button
        className="icon-button terminal-search-previous"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={!query || !results.resultCount}
        onClick={() => search.find(true)}
      >
        <ChevronUp size={17} />
      </button>
      <button
        className="icon-button terminal-search-next"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={!query || !results.resultCount}
        onClick={() => search.find()}
      >
        <ChevronDown size={17} />
      </button>
      <button
        className="icon-button terminal-search-close"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={search.close}
      >
        <X size={17} />
      </button>
    </div>
  )
}
