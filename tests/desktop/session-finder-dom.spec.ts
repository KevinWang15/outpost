import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import type { SessionFinderState } from '../../desktop/src/session-finder-api'

const sessions = Array.from({ length: 10 }, (_, index) => ({
  id: `session-${index}`,
  title: `Project ${index}`,
  server: index % 2 ? 'https://work.example' : 'https://home.example',
  sessionId: `session-${index}`,
  accountId: 'fixture',
  targetId: 'target',
  detail: '',
}))
async function open(page: Page, entries = sessions) {
  await page.addInitScript(
    (state: SessionFinderState) => {
      window.finderCalls = []
      window.outpostSessionFinder = {
        state: async () => state,
        onState: () => () => {},
        choose: id => window.finderCalls.push(id),
        create: () => window.finderCalls.push('create'),
        cancel: () => window.finderCalls.push(null),
      }
    },
    { revision: 0, title: 'Open Outpost terminal', sessions: entries, loading: false, errors: [] },
  )
  await page.goto(pathToFileURL(resolve('desktop/dist/session-finder.html')).href)
  await expect(page.getByRole('combobox')).toBeFocused()
}
declare global {
  interface Window {
    finderCalls: (string | null)[]
  }
}

test('session finder filters titles and servers, navigates with arrows and commits once', async ({ page }) => {
  await open(page)
  const input = page.getByRole('combobox')
  await expect(page.getByRole('option')).toHaveCount(10)
  await input.fill('PROJECT work')
  await expect(page.getByRole('option')).toHaveCount(5)
  await expect(input).toHaveAttribute('aria-activedescendant', 'result-0')
  await input.press('ArrowDown')
  await expect(page.getByRole('option', { selected: true })).toContainText('Project 3')
  await input.press('ArrowUp')
  await input.press('ArrowUp')
  await expect(page.getByRole('option', { selected: true })).toContainText('Project 9')
  await input.press('Enter')
  await input.press('Enter')
  expect(await page.evaluate(() => window.finderCalls)).toEqual(['session-9'])
})

test('session finder supports direct clicks and renders session titles as text', async ({ page }) => {
  await open(page, [{ ...sessions[0], title: '<img src=x onerror=alert(1)>' }])
  const option = page.getByRole('option')
  await expect(option).toContainText('<img src=x onerror=alert(1)>')
  await expect(option.locator('img')).toHaveCount(0)
  await option.click()
  expect(await page.evaluate(() => window.finderCalls)).toEqual(['session-0'])
})

test('no matches and IME Enter never select a session; Escape cancels', async ({ page }) => {
  await open(page)
  const input = page.getByRole('combobox')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await input.fill('missing session')
  await expect(page.locator('#empty')).toHaveText('No matching sessions.')
  await input.press('ArrowDown')
  await input.press('Enter')
  expect(await page.evaluate(() => window.finderCalls)).toEqual([])
  await input.press('Escape')
  expect(await page.evaluate(() => window.finderCalls)).toEqual([null])
})

test('empty recent history explains how to add a session and supports cancellation', async ({ page }) => {
  await open(page, [])
  await expect(page.locator('#empty')).toContainText('Sign in to your Outpost servers')
  await page.getByRole('combobox').press('Enter')
  expect(await page.evaluate(() => window.finderCalls)).toEqual([])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => window.finderCalls)).toEqual([null])
})
