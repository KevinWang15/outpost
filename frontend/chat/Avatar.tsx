import { Bot, UserRound } from 'lucide-react'
import type { ChatSession } from '../../shared/chatApi'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { presence, presenceLabel } from './format'
import { ToolIcon } from '../ui/ToolIcon'

/** A session: its coding tool's mark on a neutral tile, with a presence dot. */
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
  const icon = Math.round(size * 0.56)
  return (
    <span
      className="chat-avatar"
      style={{ width: size, height: size }}
      title={tool ? `${name} · ${harnessLabel(tool)}${state ? ` · ${presenceLabel[state]}` : ''}` : name}
      aria-hidden="true"
    >
      {tool ? <ToolIcon tool={tool} size={icon} /> : <Bot size={icon} />}
      {state && <i className={`presence ${state}`} />}
    </span>
  )
}

export function UserAvatar({ size = 28 }: { size?: number }) {
  return (
    <span className="chat-avatar user" style={{ width: size, height: size }} aria-hidden="true">
      <UserRound size={Math.round(size * 0.55)} />
    </span>
  )
}
