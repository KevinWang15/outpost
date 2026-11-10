import Marble from 'boring-avatars'
import { UserRound } from 'lucide-react'
import type { ChatSession } from '../../shared/chatApi'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { presence, presenceLabel } from './format'

/** Cool colors around the app's blue accent: varied per session, still one family. */
const colors = ['#1d4ed8', '#6366f1', '#0ea5e9', '#14b8a6', '#c7d2fe']

/** A session, drawn from its ID so a rename keeps its look; with a presence dot. */
export function Avatar({
  id,
  name,
  tool,
  session,
  size = 28,
}: {
  id: string
  name: string
  tool: HarnessId | null
  session?: ChatSession | null
  size?: number
}) {
  const state = session ? presence(session) : null
  return (
    <span
      className="chat-avatar"
      style={{ width: size, height: size }}
      title={tool ? `${name} · ${harnessLabel(tool)}${state ? ` · ${presenceLabel[state]}` : ''}` : name}
      aria-hidden="true"
    >
      <Marble name={id} variant="marble" colors={colors} size={size} square title={false} />
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
