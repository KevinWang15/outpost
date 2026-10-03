import { expect, test } from '@playwright/test'
import { healthySoftware } from './software-fixture'

test('environment input rejects invalid and duplicate names without submitting, then preserves remaining rows', async ({
  page,
}) => {
  const created: Record<string, unknown>[] = []
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment')
      return route.fulfill({
        json: { platform: 'linux', supported: true, usesWsl: false },
      })
    if (path === '/api/targets')
      return route.fulfill({
        json: [
          {
            id: 'options',
            kind: 'local',
            name: 'Local',
            backends: ['tmux'],
            tools: ['codex'],
            createdAt: '2026-09-30T00:00:00Z',
          },
        ],
      })
    if (path.endsWith('/software'))
      return route.fulfill({ json: healthySoftware(['tmux'], ['codex']) })
    if (path.endsWith('/sessions') && route.request().method() === 'POST') {
      created.push(route.request().postDataJSON())
      return route.fulfill({
        status: 201,
        json: {
          ...created.at(-1),
          id: 'work',
          backend: 'tmux',
          activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle',
        },
      })
    }
    if (path.endsWith('/sessions'))
      return route.fulfill({
        json: {
          sessions: [],
          registryPath: '/home/dev/.outpost/sessions.json',
        },
      })
    return route.fulfill({ json: { directories: [], truncated: false } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Session name', exact: true })
    .fill('Work')
  await page
    .getByRole('combobox', { name: 'Root directory', exact: true })
    .fill('/home/dev/project')
  await page
    .getByText('Arguments and environment variables (optional)', {
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  const firstName = page.getByRole('textbox', {
    name: 'Environment variable name 1',
    exact: true,
  })
  await firstName.fill('BAD-NAME')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create session', exact: true })
    .click()
  expect(
    await firstName.evaluate(
      (input) => (input as HTMLInputElement).validity.patternMismatch,
    ),
  ).toBe(true)
  expect(created).toHaveLength(0)
  await firstName.fill('MODEL')
  await page
    .getByRole('textbox', { name: 'Environment variable value 1', exact: true })
    .fill('first')
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Environment variable name 2', exact: true })
    .fill('MODEL')
  await page
    .getByRole('textbox', { name: 'Environment variable value 2', exact: true })
    .fill('second')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create session', exact: true })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    'Environment variable names must be unique',
  )
  expect(created).toHaveLength(0)
  await page
    .getByRole('button', { name: 'Remove environment variable 1', exact: true })
    .click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create session', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(created).toHaveLength(1)
  expect(created[0].env).toEqual({ MODEL: 'second' })
  expect(created[0].args).toBeUndefined()
})
