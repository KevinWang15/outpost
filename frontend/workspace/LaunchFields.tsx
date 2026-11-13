import { useRef, useState } from 'react'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'

/** Arguments and environment variables for a coding tool's launch, in a form. */
export default function LaunchFields({
  tool,
  args = '',
  env = {},
}: {
  tool: HarnessId | undefined
  args?: string
  env?: Record<string, string>
}) {
  const initial = Object.entries(env)
  const nextVariable = useRef(initial.length)
  const [variables, setVariables] = useState(() => initial.map(([name, value], id) => ({ id, name, value })))
  return (
    <details className="disclosure">
      <summary>
        <ChevronRight size={14} />
        Arguments and environment
      </summary>
      <label className="field">
        <span className="label">Arguments</span>
        <textarea
          name="args"
          rows={2}
          maxLength={8192}
          spellCheck={false}
          defaultValue={args}
          placeholder='--model "$MODEL"'
        />
        <small>Appended to the {tool ? harnessLabel(tool) : 'tool'} command. Bash quoting and expansion apply.</small>
      </label>
      <div className="field">
        <span className="label">Environment variables</span>
        {variables.map((variable, index) => (
          <div className="env-row" key={variable.id}>
            <input
              name="envName"
              aria-label={`Variable ${index + 1} name`}
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              maxLength={128}
              placeholder="NAME"
              spellCheck={false}
              defaultValue={variable.name}
            />
            <input
              name="envValue"
              aria-label={`Variable ${index + 1} value`}
              maxLength={4096}
              placeholder="value"
              spellCheck={false}
              defaultValue={variable.value}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove variable ${index + 1}`}
              onClick={() => setVariables(rows => rows.filter(row => row.id !== variable.id))}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button small"
          disabled={variables.length >= 32}
          onClick={() => setVariables(rows => [...rows, { id: nextVariable.current++, name: '', value: '' }])}
        >
          <Plus size={14} />
          Add variable
        </button>
      </div>
    </details>
  )
}
