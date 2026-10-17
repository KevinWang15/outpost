import type { SessionFinderState } from './session-finder-api'
import type { DesktopSessionChoice } from '../../shared/desktopAuth'
import { reconcileElements } from './keyed-elements'

const api = window.outpostSessionFinder
const input = document.querySelector<HTMLInputElement>('#query')!
const list = document.querySelector<HTMLElement>('#results')!
const status = document.querySelector<HTMLElement>('#status')!
const empty = document.querySelector<HTMLElement>('#empty')!
const rows = new Map<string, HTMLElement>()
let state: SessionFinderState = { revision: -1, title: '', sessions: [], errors: [], loading: true }
let matches: DesktopSessionChoice[] = [],
  selected = 0,
  resolved = false
function choose(id: string) {
  if (resolved) return
  resolved = true
  api.choose(id)
}
function render(preserve = true) {
  const previous = preserve ? matches[selected]?.id : undefined
  const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filtered = state.sessions.filter(session =>
    terms.every(term => `${session.title} ${session.server} ${session.detail}`.toLocaleLowerCase().includes(term)),
  )
  // Search the entire catalogue, but keep a bounded list of visible rows.
  matches = filtered.slice(0, 200)
  const retained = matches.findIndex(session => session.id === previous)
  selected = retained >= 0 ? retained : Math.max(0, Math.min(selected, matches.length - 1))
  reconcileElements(
    list,
    rows,
    matches,
    session => session.id,
    session => {
      const row = document.createElement('li')
      row.setAttribute('role', 'option')
      const title = document.createElement('strong'),
        server = document.createElement('span')
      row.append(title, server)
      row.onpointerdown = event => event.preventDefault()
      row.onclick = () => choose(session.id)
      return row
    },
    (row, session, index) => {
      row.id = `result-${index}`
      row.setAttribute('aria-selected', String(index === selected))
      row.querySelector('strong')!.textContent = session.title
      row.querySelector('span')!.textContent = session.server
      row.title = `${session.title}\n${session.server}\n${session.detail}`
    },
  )
  if (matches.length) input.setAttribute('aria-activedescendant', `result-${selected}`)
  else input.removeAttribute('aria-activedescendant')
  list.hidden = matches.length === 0
  empty.hidden = state.loading || matches.length > 0
  empty.textContent = state.sessions.length
    ? 'No matching sessions.'
    : 'No sessions available. Sign in to your Outpost servers from the Outpost tab.'
  const count =
    filtered.length > matches.length
      ? `Showing ${matches.length} of ${filtered.length} matches. Type to narrow the search.`
      : `${filtered.length} ${filtered.length === 1 ? 'session' : 'sessions'}`
  status.hidden = !state.loading && matches.length === 0
  status.textContent = state.loading ? `Loading sessions…${matches.length ? ' ' + count : ''}` : count
  const errors = document.querySelector<HTMLElement>('#errors')!
  errors.textContent = state.errors.join('\n')
  errors.hidden = state.errors.length === 0
  list.children[selected]?.scrollIntoView({ block: 'nearest' })
}
input.oninput = () => {
  selected = 0
  render(false)
}
input.onkeydown = event => {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (matches.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
    render(false)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (matches[selected]) choose(matches[selected].id)
  }
}
document.querySelector<HTMLButtonElement>('#cancel')!.onclick = () => api.cancel()
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault()
    api.cancel()
  }
})
window.addEventListener('focus', () => input.focus())
function accept(next: SessionFinderState) {
  if (next.revision <= state.revision || resolved) return
  state = next
  document.querySelector<HTMLElement>('#title')!.textContent = next.title
  render()
}
api.onState(accept)
void api
  .state()
  .then(next => {
    accept(next)
    input.disabled = false
    input.focus()
  })
  .catch(() => {
    status.hidden = true
    list.hidden = true
    empty.hidden = false
    empty.textContent = 'Could not load sessions. Close this finder and try again.'
  })
