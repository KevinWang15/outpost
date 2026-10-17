import type { Page } from '@playwright/test'

/** Desktop panes reveal the optional terminal toolbar through the terminal menu. */
export async function showTerminalToolbar(page: Page) {
  await page.locator('.terminal-surface').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: 'Terminal toolbar', exact: true }).click()
}
