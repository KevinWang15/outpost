import { chatBridgeVersion, type ChatBridge } from '../../shared/chatBridge'
import { pagePaths } from '../../shared/pages'
import ChatApp from './ChatApp'

declare global {
  interface Window {
    outpostChat?: ChatBridge
  }
}

/** Outpost Desktop's chat window. The app's chat preload supplies a scoped ticket;
 * this page has no browser login and no other credential. */
export default function DesktopChatPage() {
  const bridge = window.outpostChat
  if (!bridge)
    return (
      <div className="auth-loading">
        <p>
          This page opens inside Outpost Desktop. In a browser, use <a href={pagePaths.chat}>Outpost chat</a>.
        </p>
      </div>
    )
  if (bridge.version !== chatBridgeVersion)
    return (
      <div className="auth-loading">
        <p>Update Outpost Desktop to use chat with this server.</p>
      </div>
    )
  return <ChatApp bridge={bridge} />
}
