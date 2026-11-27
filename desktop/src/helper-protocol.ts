import type { SessionInput } from '../../shared/model'
import type { ImagePasteMode } from '../../shared/terminalFiles'

export type Emit = (event: string, payload?: object) => void

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type PaneCommand =
  | { op: 'ack'; pane: number; seq: number }
  | { op: 'input'; pane: number; data: string }
  | { op: 'resize'; pane: number; cols: number; rows: number }
  | { op: 'focus'; pane: number; active: boolean }
  | { op: 'observe'; pane: number }
  | { op: 'resume'; pane: number }
  | { op: 'reconnect'; pane: number }
  | { op: 'close'; pane: number }
  | { op: 'draft'; pane: number; active: boolean }
  | { op: 'submit'; pane: number; text: string }
  | { op: 'clear'; pane: number }
  | { op: 'deliver'; pane: number }
  | { op: 'image'; pane: number; data: string; mime: string; mode: ImagePasteMode }
  | { op: 'files'; pane: number }
  | { op: 'preview'; pane: number; file: unknown }
  | { op: 'saveFile'; pane: number; file: unknown; path: string }
  | { op: 'deleteFile'; pane: number; file: unknown }

export type HelperCommand =
  | PaneCommand
  | { op: 'answer'; id: number; answer: boolean }
  | { op: 'link'; value: string; window?: number }
  | { op: 'login'; origin: string }
  | { op: 'cancel'; origin: string }
  | { op: 'logout'; origin: string }
  | { op: 'refresh' }
  | { op: 'forget' }
  | { op: 'choose'; value: string; window?: number }
  | {
      op: 'openSession'
      window?: number
      sessionId?: string
      origin?: string
      targetId?: string
      hostname?: string
      name?: string
      paneServer?: string
    }
  | {
      op: 'prefs'
      fontSize: number
      sound: boolean
      scrollbackLines: number
      unlimitedScrollback: boolean
      localShell: string | null
    }
  | { op: 'targets'; window: number; origin: string; accountId: string }
  | { op: 'options'; window: number; origin: string; accountId: string; target: string }
  | { op: 'directories'; window: number; id: number; origin: string; accountId: string; target: string; path?: string }
  | { op: 'create'; window: number; origin: string; accountId: string; target: string; input: SessionInput }
