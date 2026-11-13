import { expect, test, type Page } from '@playwright/test'

async function addClaudeTarget(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add target' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a target' })
  await dialog.getByRole('radio', { name: 'This computer' }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Add target' }).click()
  await expect(page.getByRole('region', { name: 'Required software' })).toContainText('Ready')
}

async function newSession(page: Page, name: string, directory: string, instructions = '') {
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

test('chat mode: talk to a session, approve a step, and work with sessions in a channel', async ({ page }) => {
  if (process.env.CHAT_DEBUG)
    page.on('websocket', socket => {
      if (!socket.url().includes('/api/chat')) return
      socket.on('framesent', frame => console.log('>>', String(frame.payload).slice(0, 200)))
      socket.on('framereceived', frame => console.log('<<', String(frame.payload).slice(0, 200)))
      socket.on('close', () => console.log('WS CLOSED'))
    })
  await addClaudeTarget(page, 'Chat box')
  await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Chat' }).click()
  await expect(page).toHaveURL(/\/chat$/)

  await newSession(page, 'Coder', '~/chat-coder', 'Be brief.')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Check the build')
  await composer.press('Enter')
  await expect(page.locator('.prompt').last()).toContainText('Check the build')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Check the build')
  // Steps fold into one line and open to the tool call and its output.
  await page
    .getByRole('button', { name: /Worked · 1 step/ })
    .last()
    .click()
  await page
    .getByRole('button', { name: /Run fixture check/ })
    .last()
    .click()
  await expect(page.locator('.step-output').last()).toContainText('running\nchecked')

  await composer.fill('Please ask permission first')
  await composer.press('Enter')
  const request = page.getByRole('group', { name: 'Permission request' })
  await expect(request).toContainText('Run fixture check')
  await expect(page.getByRole('button', { name: /Coder/ }).first()).toBeVisible()
  await request.getByRole('button', { name: 'Allow' }).click()
  await expect(page.locator('.reply .markdown').last()).toContainText('Permission granted.')

  // A file the agent publishes shows in its turn and in the session's Files.
  await composer.fill('publish report.txt')
  await composer.press('Enter')
  const card = page.locator('.reply .file-card').last()
  await expect(card).toContainText('report.txt')
  await page.getByRole('button', { name: 'Files (1)' }).click()
  const files = page.getByRole('complementary', { name: 'Session files' })
  await expect(files).toContainText('report.txt')
  await card.getByRole('button', { name: /View report\.txt/ }).click()
  const viewer = page.getByRole('dialog', { name: 'Session file viewer' })
  await expect(viewer).toContainText('report.txt')
  await viewer.getByRole('button', { name: 'Close viewer' }).click()
  await files.getByRole('button', { name: 'Remove report.txt' }).click()
  await expect(card).toContainText('Removed')
  await files.getByRole('button', { name: 'Close files' }).click()

  await newSession(page, 'Writer', '~/chat-writer')
  await page.getByRole('button', { name: 'New channel' }).click()
  const channel = page.getByRole('dialog', { name: 'New channel' })
  await channel.getByLabel('Name').fill('Release Team')
  await expect(channel.getByLabel('Name')).toHaveValue('release-team')
  await channel.getByLabel(/^Coder/).check()
  await channel.getByLabel(/^Writer/).check()
  await channel.getByRole('button', { name: 'Create channel' }).click()
  await expect(page.getByRole('heading', { name: 'release-team', level: 1 })).toBeVisible()

  const message = page.getByRole('textbox', { name: 'Message' })
  await message.fill('@wr')
  await page.getByRole('option', { name: /@writer/ }).click()
  await expect(message).toHaveValue('@writer ')
  await message.pressSequentially('draft the notes')
  await message.press('Enter')
  const reply = page.locator('.channel-message').filter({ hasText: 'Fixture reply to: You are writer' })
  await expect(reply).toBeVisible()
  await expect(reply.getByRole('button', { name: 'Writer' })).toBeVisible()
  await reply.getByRole('button', { name: 'Steps' }).click()
  await expect(reply.locator('.member-steps')).toContainText('Worked')

  // The same conversation, seen from Terminal mode, is running in chat.
  await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Terminal' }).click()
  await expect(page).toHaveURL(/\/(\?.*)?$/)
  await expect(page.getByRole('row').filter({ hasText: 'Coder' })).toBeVisible()
})

test('a remembered web terminal opens once, from the click that moves a chat session', async ({ page, context }) => {
  await addClaudeTarget(page, 'Handoff box')
  await page.evaluate(() => localStorage.setItem('outpost.connection.terminal', 'web'))
  await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Chat' }).click()
  await newSession(page, 'Handoff', '~/chat-handoff')
  const popups: string[] = []
  context.on('page', popup => popups.push(popup.url()))
  await page.getByRole('button', { name: 'Actions for Handoff' }).click()
  await page.getByRole('menuitem', { name: 'Open in terminal' }).click()
  const dialog = page.getByRole('dialog', { name: /in a terminal/ })
  const continueButton = dialog.getByRole('button', { name: 'Continue in a terminal' })
  if (await continueButton.isVisible()) await continueButton.click()
  const opened = context.waitForEvent('page')
  await dialog.getByRole('button', { name: 'Open terminal' }).click()
  const terminal = await opened
  await expect(terminal).toHaveURL(/\/terminal\?.*session=/)
  await expect(dialog).toBeHidden()
  // StrictMode replays mount effects; the handoff must not open a second window.
  await page.waitForTimeout(500)
  expect(popups).toHaveLength(1)
})
