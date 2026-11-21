import type { DesktopSession } from './desktopAuth'
import type { Session } from './model'
export function desktopSession(session: Session, target: { id: string; name: string }): DesktopSession {
  return {
    sessionId: session.id,
    targetId: target.id,
    title: `${session.name} · ${target.name}`,
    detail: `${session.tool} · ${session.rootDir} · ${session.status}`.slice(0, 4096),
    tool: session.tool,
  }
}
