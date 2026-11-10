/** Outpost Desktop's chat window bridge (`window.outpostChat`), exposed by its
 * chat preload. The renderer is the server's /chat/desktop page. */
export const chatBridgeVersion = 1

export interface ChatTicket {
  ticket: string
}

export interface ChatBridge {
  version: number
  /** A fresh single-use ticket for this window's server account. */
  ticket(): Promise<ChatTicket>
  /** Open an http(s) link in the system browser. */
  openLink(url: string): void
  /** Open a managed session in Outpost Desktop's terminal workspace. */
  openTerminal(targetId: string, sessionId: string): Promise<void>
}
