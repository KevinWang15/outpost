import type { CodingTool } from '../shared/session-manager'
import { codingToolLabels } from '../shared/session-manager'

export default function ToolPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: CodingTool[]
  onChange: (tools: CodingTool[]) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="tool-picker" disabled={disabled}>
      <legend>Required coding tools</legend>
      <div>
        {(Object.keys(codingToolLabels) as CodingTool[]).map((tool) => (
          <label key={tool}>
            <input
              type="checkbox"
              checked={value.includes(tool)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...value, tool]
                    : value.filter((item) => item !== tool),
                )
              }
            />
            {codingToolLabels[tool]}
          </label>
        ))}
      </div>
      <small>
        Select the coding tools you want to use for new sessions on this
        instance.
      </small>
    </fieldset>
  )
}
