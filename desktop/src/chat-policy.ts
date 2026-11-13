import { pagePaths } from '../../shared/pages'

/** A chat window shows exactly its server's chat page, with any query. */
export function chatPageUrl(origin: string) {
  return `${origin}${pagePaths.desktopChat}`
}

export function chatNavigationAllowed(origin: string, url: string) {
  try {
    const parsed = new URL(url)
    return parsed.origin === origin && parsed.pathname === pagePaths.desktopChat && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

interface ChatTicketResponse {
  server: string
  accountId: string
  ticket: string
  protocol: number
}

export function validChatTicket(value: unknown, origin: string, accountId: string): value is ChatTicketResponse {
  if (!value || typeof value !== 'object') return false
  const item = value as ChatTicketResponse
  return (
    item.server === origin &&
    item.accountId === accountId &&
    typeof item.ticket === 'string' &&
    item.ticket.length > 0 &&
    item.ticket.length <= 4096 &&
    Number.isInteger(item.protocol)
  )
}
