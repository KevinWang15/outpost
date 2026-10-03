import type { SessionBackend } from '../shared/session-manager'

const backends: Record<SessionBackend, string> = {
  tmux: 'Screen restoration and scrollback',
  dtach: 'Minimal session persistence',
}

export default function BackendPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: SessionBackend[]
  onChange: (backends: SessionBackend[]) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="tool-picker backend-picker" disabled={disabled}>
      <legend>Required session backends</legend>
      <div>
        {(Object.keys(backends) as SessionBackend[]).map((backend) => (
          <label key={backend} title={backends[backend]}>
            <input
              type="checkbox"
              checked={value.includes(backend)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, backend]
                    : value.filter((item) => item !== backend),
                )
              }
            />
            {backend}
          </label>
        ))}
      </div>
      <small>
        Choose tmux, dtach, or both for new sessions. tmux retains the screen
        and scrollback; dtach provides minimal session persistence.
      </small>
    </fieldset>
  )
}
