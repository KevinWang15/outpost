import { createServer, type IncomingHttpHeaders } from 'node:http'
import { expect, test } from '@playwright/test'
import { addClaudeTarget, newSession } from './chat-fixture'

test('logs show what sessions did, filter by kind, and webhooks deliver it', async ({ page }) => {
  const received: { headers: IncomingHttpHeaders; body: { event: { kind: string; message: string } } }[] = []
  const receiver = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(body) })
      response.end()
    })
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`

  await addClaudeTarget(page, 'Logs box')
  await page.getByRole('link', { name: 'Logs and webhooks' }).click()
  await expect(page).toHaveURL(/\/logs$/)
  // A webhook for agent status, with a header the receiver can check.
  await page.getByRole('button', { name: 'New webhook' }).click()
  const create = page.getByRole('dialog', { name: 'New webhook' })
  await create.getByLabel('Name').fill('Receiver')
  await create.getByLabel('URL').fill(url)
  await create.getByRole('button', { name: 'Add header' }).click()
  await create.getByLabel('Header 1 name').fill('Authorization')
  await create.getByLabel('Header 1 value').fill('Bearer logs-test')
  await create.getByLabel('Agent status').check()
  await create.getByRole('button', { name: 'Create webhook' }).click()
  await expect(create).toBeHidden()

  await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Chat' }).click()
  await newSession(page, 'Logger', '~/logs-logger')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Check the build')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Check the build')

  // The viewer follows the newest entries; the quick views narrow them by kind.
  await page.goto('/logs')
  const viewer = page.frameLocator('iframe.log-frame')
  await expect(viewer.getByText('Logger finished its turn').last()).toBeVisible()
  await page.getByRole('button', { name: 'Machines' }).click()
  await expect(viewer.getByText('Logs box was added')).toBeVisible()
  await expect(viewer.getByText('Logger finished its turn')).toHaveCount(0)
  await page.getByRole('button', { name: 'Agent status' }).click()
  await expect(viewer.getByText('Logger finished its turn').last()).toBeVisible()
  await expect(viewer.getByText('Logs box was added')).toHaveCount(0)

  await expect.poll(() => received.some(item => item.body.event.message === 'Logger finished its turn')).toBe(true)
  expect(received.every(item => item.body.event.kind === 'agent')).toBe(true)
  expect(received[0].headers.authorization).toBe('Bearer logs-test')

  // The saved header is not shown again; a test send reports what happened.
  await page.getByRole('button', { name: /Receiver/ }).click()
  const edit = page.getByRole('dialog', { name: 'Edit Receiver' })
  await expect(edit.getByLabel('Header 1 value')).toHaveValue('')
  await edit.getByRole('button', { name: 'Send a test' }).click()
  await expect(edit.getByText('Test: Delivered (200).')).toBeVisible()
  receiver.close()
})
