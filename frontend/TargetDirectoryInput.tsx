import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { DirectorySuggestions } from '../shared/session-manager'
import { api } from './api'

type Lookup = { targetId: string; path: string; data?: DirectorySuggestions; error?: string }

export default function TargetDirectoryInput({ targetId }: { targetId: string }) {
  const id = useId()
  const field = useRef<HTMLDivElement>(null)
  const control = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [path, setPath] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [attempt, setAttempt] = useState(0)
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const valid = (path === '' || path === '~' || path.startsWith('~/') || path.startsWith('/'))
    && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  const current = lookup?.targetId === targetId && lookup.path === path ? lookup : null
  const directories = current?.data?.directories ?? []
  const visible = open && valid
  const activeId = visible && directories[active] ? `${id}-option-${active}` : undefined

  useEffect(() => {
    if (!open || !valid) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api<DirectorySuggestions>(`/targets/${targetId}/directories?path=${encodeURIComponent(path)}`, 'GET', undefined, controller.signal)
        .then(data => { if (!controller.signal.aborted) setLookup({ targetId, path, data }) })
        .catch(error => { if (!controller.signal.aborted) setLookup({ targetId, path, error: (error as Error).message }) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [targetId, path, open, valid, attempt])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  useEffect(() => {
    if (!open) return
    function dismissSuggestions(event: PointerEvent) {
      if (control.current?.contains(event.target as Node)) return
      // Clicking anywhere outside the input and its popup commits the current
      // path as the user's choice: keep the value, close the list, and release
      // focus so nothing can reopen the suggestions on its own.
      setOpen(false)
      setActive(-1)
      if (document.activeElement === input.current) input.current?.blur()
    }
    document.addEventListener('pointerdown', dismissSuggestions, true)
    return () => document.removeEventListener('pointerdown', dismissSuggestions, true)
  }, [open])

  function choose(directory: string) {
    setPath(directory); setLookup(null); setActive(-1); setOpen(true)
  }
  function reopen() {
    setLookup(null); setActive(-1); setOpen(true); setAttempt(value => value + 1)
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { reopen(); return }
      if (directories.length) setActive(index => event.key === 'ArrowDown'
        ? (index + 1) % directories.length
        : index <= 0 ? directories.length - 1 : index - 1)
    } else if (visible && ((event.key === 'Enter' && directories[active])
      || (event.key === 'Tab' && !event.shiftKey && (directories[active] || directories.length === 1)))) {
      event.preventDefault()
      choose(directories[active] ?? directories[0])
    }
  }

  return <div ref={field} className="directory-field" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1) }
  }}>
    <label id={`${id}-label`}>Root directory</label>
    <div className="directory-control" ref={control}>
      <input ref={input} id={id} name="rootDir" placeholder="~/projects/my-app" required maxLength={4096}
        value={path} onChange={event => choose(event.target.value)} onFocus={reopen} onClick={() => { if (!open) reopen() }} onKeyDown={keyDown}
        spellCheck={false} autoComplete="off" role="combobox" aria-autocomplete="list" aria-labelledby={`${id}-label`}
        aria-expanded={visible} aria-controls={visible ? `${id}-list` : undefined}
        aria-activedescendant={activeId} aria-describedby={`${id}-help`}/>
      {visible && <div className="directory-popup">
        <ul id={`${id}-list`} role="listbox" aria-label="Target directories">
          {directories.map((directory, index) => <li key={directory} role="presentation">
            <button type="button" role="option" id={`${id}-option-${index}`} tabIndex={-1}
              aria-selected={active === index} onPointerDown={event => event.preventDefault()}
              onClick={() => choose(directory)}><CornerDownRight size={14} aria-hidden="true" /><code>{directory}</code></button>
          </li>)}
        </ul>
        <p className="directory-status" role="status">{!current ? 'Looking up target directories…'
          : current.error ? `Could not load suggestions: ${current.error}. You can still enter a path.`
          : !directories.length ? 'No matching directories. You can still enter a new path.'
          : current.data?.truncated ? 'Showing 50 matches. Keep typing to narrow the list.'
          : 'Use ↑ / ↓ and Enter to select. Tab completes a single match.'}</p>
        {current?.error && <button type="button" className="directory-retry" onPointerDown={event => event.preventDefault()} onClick={reopen}>Retry lookup</button>}
      </div>}
    </div>
    <small id={`${id}-help`}>An absolute path or ~/path on the target machine. Suggestions are fetched live.</small>
  </div>
}
