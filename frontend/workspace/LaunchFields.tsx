import { useState } from 'react'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import { appliesIn, harnessLabel, supportsTerminal, type HarnessId } from '../../shared/harnesses'
import { envRow, type LaunchDraft } from './launch'

const where = (drivers: readonly string[]) =>
  drivers.length === 2 ? 'in terminals and in chat' : `in ${drivers[0]} only`

const serversExample = `{
  "docs": { "type": "http", "url": "https://example.com/mcp" },
  "db": { "command": "npx", "args": ["-y", "my-db-mcp"], "env": { "DB_URL": "…" } }
}`

/** What a session's coding tool starts with: instructions in view, the
 * technical settings in a disclosure. */
export default function LaunchFields({
  tool,
  value,
  onChange,
}: {
  tool: HarnessId | undefined
  value: LaunchDraft
  onChange: (value: LaunchDraft) => void
}) {
  const label = tool ? harnessLabel(tool) : 'the coding tool'
  const set = (change: Partial<LaunchDraft>) => onChange({ ...value, ...change })
  const instructions = tool ? appliesIn(tool, 'instructions') : ['terminal', 'chat']
  const servers = tool ? appliesIn(tool, 'servers') : ['terminal', 'chat']
  const terminal = !tool || supportsTerminal(tool)
  // Open when something in it is set; the user's toggling stands after that.
  const [open] = useState(
    () => [value.model, value.mode, value.servers, value.args].some(item => item.trim()) || value.env.length > 0,
  )
  return (
    <>
      <label className="field">
        <span className="label">Instructions</span>
        <textarea
          name="instructions"
          rows={3}
          maxLength={32000}
          value={value.instructions}
          onChange={event => set({ instructions: event.target.value })}
          placeholder="Optional. A role or rules for this session, e.g. “You review pull requests. Be concise.”"
        />
        <small>
          {instructions.length
            ? `Added to ${label}’s own instructions, ${where(instructions)}.`
            : `${label} does not accept session instructions yet.`}
        </small>
      </label>
      <details className="disclosure" open={open}>
        <summary>
          <ChevronRight size={14} />
          Model, MCP servers and launch
        </summary>
        <div className="field">
          <div className="field-pair">
            <label className="field">
              <span className="label">Model</span>
              <input
                name="model"
                maxLength={200}
                spellCheck={false}
                value={value.model}
                onChange={event => set({ model: event.target.value })}
                placeholder="Tool default"
              />
            </label>
            <label className="field">
              <span className="label">Chat mode</span>
              <input
                name="mode"
                maxLength={200}
                spellCheck={false}
                value={value.mode}
                onChange={event => set({ mode: event.target.value })}
                placeholder="Tool default"
              />
            </label>
          </div>
          <small>
            As {label} names them, e.g. in the chat’s model and mode menus. Chat selects both whenever a conversation
            opens{terminal ? '; terminals start with the model' : ''}.
          </small>
        </div>
        <label className="field">
          <span className="label">MCP servers</span>
          <textarea
            name="mcpServers"
            rows={value.servers ? 6 : 2}
            spellCheck={false}
            className="code"
            value={value.servers}
            onChange={event => set({ servers: event.target.value })}
            placeholder={serversExample}
          />
          <small>
            A JSON object in the usual mcpServers format: a command with args and env, or "type": "http" with a url and
            headers. Added alongside Outpost’s own server, {where(servers)}.
          </small>
        </label>
        {terminal && (
          <label className="field">
            <span className="label">Arguments</span>
            <textarea
              name="args"
              rows={2}
              maxLength={8192}
              spellCheck={false}
              value={value.args}
              onChange={event => set({ args: event.target.value })}
              placeholder="--verbose"
            />
            <small>Appended to the {label} command in terminals. Bash quoting and expansion apply.</small>
          </label>
        )}
        <div className="field">
          <span className="label">Environment variables</span>
          {value.env.map((variable, index) => (
            <div className="env-row" key={variable.id}>
              <input
                aria-label={`Variable ${index + 1} name`}
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                maxLength={128}
                placeholder="NAME"
                spellCheck={false}
                value={variable.name}
                onChange={event =>
                  set({
                    env: value.env.map(row => (row.id === variable.id ? { ...row, name: event.target.value } : row)),
                  })
                }
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                maxLength={4096}
                placeholder="value"
                spellCheck={false}
                value={variable.value}
                onChange={event =>
                  set({
                    env: value.env.map(row => (row.id === variable.id ? { ...row, value: event.target.value } : row)),
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove variable ${index + 1}`}
                onClick={() => set({ env: value.env.filter(row => row.id !== variable.id) })}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button small"
            disabled={value.env.length >= 32}
            onClick={() => set({ env: [...value.env, envRow()] })}
          >
            <Plus size={14} />
            Add variable
          </button>
        </div>
      </details>
    </>
  )
}
