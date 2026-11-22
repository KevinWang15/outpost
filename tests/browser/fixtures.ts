import { test as base, expect } from '@playwright/test'
import type { Target } from '../../shared/model'

export { expect }
export type { Page } from '@playwright/test'

// Browser tests share a disposable server and each starts with an empty machine list.
export const test = base.extend<{ machineWorkspace: void }>({
  machineWorkspace: [
    async ({ request }, use) => {
      const targets: Target[] = await (await request.get('/api/targets')).json()
      for (const target of targets) {
        const removed = await request.delete('/api/targets/' + target.id, { headers: { 'x-outpost-request': '1' } })
        expect(removed.status()).toBe(204)
      }
      await use()
    },
    { auto: true },
  ],
})
