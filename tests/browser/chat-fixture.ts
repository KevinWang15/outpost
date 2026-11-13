import { expect, type Page } from '@playwright/test'

/** Add this computer as a target with the fixture coding tools, from the workspace. */
export async function addClaudeTarget(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add target' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a target' })
  await dialog.getByRole('radio', { name: 'This computer' }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Add target' }).click()
  await expect(page.getByRole('region', { name: 'Required software' })).toContainText('Ready')
}

/** Create a session from chat's New session dialog. */
export async function newSession(page: Page, name: string, directory: string, instructions = '') {
  await page.getByRole('button', { name: 'New session' }).last().click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('combobox', { name: 'Project directory' }).fill(directory)
  await dialog.getByText('Create the directory if it doesn’t exist').click()
  if (instructions) await dialog.getByLabel('Instructions').fill(instructions)
  await dialog.getByRole('button', { name: 'Create session' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}
