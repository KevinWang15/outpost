import type { HarnessId } from '../../shared/harnesses'
import { harnessMarks } from '../../shared/harnessMarks'

/** The coding tool's mark, sized like a Lucide icon. */
export function ToolIcon({ tool, size = 16 }: { tool: HarnessId; size?: number }) {
  const mark = harnessMarks[tool]
  return (
    <svg className="tool-icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {mark.paths.map(d => (
        <path key={d} d={d} fillRule="evenodd" clipRule={mark.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  )
}
