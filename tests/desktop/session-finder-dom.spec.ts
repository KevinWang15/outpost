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
      let listener: (state: SessionFinderState) => void = () => {}
      window.finderUpdate = update => {
        state = { ...state, ...update, revision: state.revision + 1 }
        listener(state)
      }
      window.outpostSessionFinder = {
        state: async () => state,
        onState: callback => {
          listener = callback
          return () => {}
        },
        choose: id => window.finderCalls.push(id),
        create: () => window.finderCalls.push('create'),
        refresh: () => window.finderCalls.push('refresh'),
        cancel: () => window.finderCalls.push(null),
      }
    },
    {
      revision: 0,
      title: 'Open Outpost terminal',
      sessions: entries,
      loading: false,
      errors: [],
      busy: 'idle' as const,
      actionError: null,
    },
  )
  await page.goto(pathToFileURL(resolve('desktop/dist/session-finder.html')).href)
  await expect(page.getByRole('combobox')).toBeFocused()
}
declare global {
  interface Window {
    finderCalls: (string | null)[]
    finderUpdate(update: Partial<SessionFinderState>): void
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

test('connection errors release the submit guard and retain the selected row for retry', async ({ page }) => {
  await open(page)
  const input = page.getByRole('combobox')
  await input.fill('work')
  await input.press('ArrowDown')
  await input.press('Enter')
  await page.evaluate(() => window.finderUpdate({ busy: 'connecting' }))
  await expect(input).toBeDisabled()
  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
  await page.evaluate(() => window.finderUpdate({ busy: 'idle', actionError: 'Temporary connection failure' }))
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('work')
  await expect(page.getByRole('option', { selected: true })).toContainText('Project 3')
  await input.press('Enter')
  expect(await page.evaluate(() => window.finderCalls)).toEqual(['session-3', 'session-3'])
})

test('refresh errors retain results and the retry control; a created session is focused only once', async ({
  page,
}) => {
  await open(page)
  const input = page.getByRole('combobox')
  await input.fill('nonmatching query')
  await page.evaluate(
    sessions =>
      window.finderUpdate({
        sessions,
        focusId: sessions[0].id,
        errors: ['Offline'],
      }),
    sessions,
  )
  await expect(input).toHaveValue('')
  await expect(page.getByRole('option', { selected: true })).toContainText('Project 0')
  await input.press('ArrowDown')
  await input.fill('work')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  expect(await page.evaluate(() => window.finderCalls)).toEqual(['refresh'])
  await page.evaluate(() => window.finderUpdate({ loading: true, errors: [] }))
  await expect(input).toHaveValue('work')
  await expect(page.getByRole('option', { selected: true })).toContainText('Project 1')
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled()
})
