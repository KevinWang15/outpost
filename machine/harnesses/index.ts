import type { HarnessId } from '../../shared/harnesses'
import { Claude } from './claude'
import { Codex } from './codex'
import { DeepSeek } from './deepseek'
import type { Harness } from './harness'
import { Kimi } from './kimi'

const adapters: Record<HarnessId, Harness> = {
  claude: new Claude(),
  codex: new Codex(),
  kimi: new Kimi(),
  deepseek: new DeepSeek(),
}
export const harness = (id: HarnessId) => adapters[id]
export const allHarnesses = () => Object.values(adapters)
