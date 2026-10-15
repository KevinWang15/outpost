import { desktopBridgeVersion, type DesktopBridge } from '../shared/desktop'

declare global {
  interface Window {
    outpostDesktop?: DesktopBridge
  }
}
export const desktop = window.outpostDesktop?.version === desktopBridgeVersion ? window.outpostDesktop : null
export const desktopProblem =
  window.outpostDesktop && !desktop
    ? window.outpostDesktop.version < desktopBridgeVersion
      ? 'Update Outpost Desktop to match this server, then reopen the session.'
      : 'Update your Outpost server to match Outpost Desktop, then reload this terminal.'
    : null
