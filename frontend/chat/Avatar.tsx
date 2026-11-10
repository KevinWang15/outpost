import type { ChatSession } from '../../shared/chatApi'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { harnessColor, presence, presenceLabel } from './format'

export function Avatar({
  name,
  tool,
  session,
  size = 28,
}: {
  name: string
  tool: HarnessId | null
  session?: ChatSession | null
  size?: number
}) {
  const state = session ? presence(session) : null
  return (
    <span
      className="chat-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: tool ? harnessColor[tool] : 'var(--accent)',
      }}
      title={tool ? `${name} · ${harnessLabel(tool)}${state ? ` · ${presenceLabel[state]}` : ''}` : name}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
      {state && <i className={`presence ${state}`} />}
    </span>
  )
}

export function UserAvatar({ size = 28 }: { size?: number }) {
  return (
    <span className="chat-avatar user" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      You
    </span>
  )
}
