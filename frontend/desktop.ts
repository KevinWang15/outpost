import { desktopBridgeVersion, type DesktopBridge } from '../shared/desktop'

declare global {
  interface Window {
    outpostDesktop?: DesktopBridge
  }
}
export const desktop = window.outpostDesktop?.version === desktopBridgeVersion ? window.outpostDesktop : null
