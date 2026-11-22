import { expect, test } from './fixtures'
import { addClaudeTarget, newSession } from './chat-fixture'

test('Machines remains the home page after visiting Chat', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('outpost:mode', 'chat'))
  const addMachine = page.getByRole('button', { name: 'Add a machine', exact: true }).first()
  await page.goto('/')
  await expect(addMachine).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('link', { name: 'Chat' }).click()
  await expect(page).toHaveURL(/\/chat$/)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Back to machines' })).toBeVisible()
  await page.locator('a.brand').click()
  await expect(addMachine).toBeVisible()
})

test('Outpost Chat: talk to a session, approve a step, and work with sessions in a channel', async ({ page }) => {
  if (process.env.CHAT_DEBUG)
    page.on('websocket', socket => {
      if (!socket.url().includes('/api/chat')) return
      socket.on('framesent', frame => console.log('>>', String(frame.payload).slice(0, 200)))
      socket.on('framereceived', frame => console.log('<<', String(frame.payload).slice(0, 200)))
      socket.on('close', () => console.log('WS CLOSED'))
    })
  await addClaudeTarget(page, 'Chat box')
  await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('link', { name: 'Chat' }).click()
  await expect(page).toHaveURL(/\/chat$/)

  await expect(page.getByRole('heading', { name: 'Chat box' }).getByRole('link')).toHaveAttribute('href', /\/\?target=/)
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

  // Files the user attaches go to the session's files; the agent reads them, and sees images inline.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await page.locator('.chat-composer input[type=file]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Ship on Friday\n') },
    { name: 'dot.png', mimeType: 'image/png', buffer: png },
  ])
  await expect(page.locator('.attachments')).toContainText('notes.txt')
  await composer.fill('Summarize these')
  await composer.press('Enter')
  await expect(page.locator('.prompt').last().locator('.file-card')).toHaveCount(2)
  const summary = page.locator('.reply .markdown').last()
  await expect(summary).toContainText('(1 image) (read notes.txt: Ship on Friday) (read dot.png')
  await expect(page.getByRole('button', { name: 'Files (2)' })).toBeVisible()

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
  await page.locator('.chat-composer input[type=file]').setInputFiles({
    name: 'brief.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Launch brief\n'),
  })
  await expect(page.locator('.attachments')).toContainText('brief.md')
  await message.press('Enter')
  await expect(
    page.locator('.channel-message').filter({ hasText: 'draft the notes' }).locator('.file-card'),
  ).toContainText('brief.md')
  const reply = page
    .locator('.channel-message')
    .filter({ hasText: 'Fixture reply to: the user: writer draft the notes' })
  await expect(reply).toBeVisible()
  await expect(reply).toContainText('(read brief.md: # Launch brief)')
  await expect(reply.getByRole('button', { name: 'Writer' })).toBeVisible()
  await reply.getByRole('button', { name: 'Steps' }).click()
  await expect(reply.locator('.member-steps')).toContainText('Worked')

  // The same conversation, seen from Machines, is running in chat.
  await page.getByRole('link', { name: 'Back to machines' }).click()
  await expect(page).toHaveURL(/\/(\?.*)?$/)
  await expect(page.getByRole('row').filter({ has: page.getByText('Coder', { exact: true }) })).toBeVisible()
})

test('a remembered web terminal shares prompts and replies with the open Chat view', async ({ page, context }) => {
  await addClaudeTarget(page, 'Handoff box')
  await page.evaluate(() => localStorage.setItem('outpost.connection.terminal', 'web'))
  await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('link', { name: 'Chat' }).click()
  await newSession(page, 'Handoff', '~/chat-handoff')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Start in Chat')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Start in Chat')
  const popups: string[] = []
  context.on('page', popup => popups.push(popup.url()))
  await page.getByRole('button', { name: 'Actions for Handoff' }).click()
  const opened = context.waitForEvent('page')
  await page.getByRole('menuitem', { name: 'Open in Terminal' }).click()
  const terminal = await opened
  await expect(terminal).toHaveURL(/\/terminal\?.*session=/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const output = terminal.locator('.xterm-rows')
  await expect(output).toContainText('Start in Chat')
  const input = terminal.getByRole('textbox', { name: 'Terminal input' })
  await input.pressSequentially('Hello from Terminal')
  await input.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Hello from Terminal')
  await terminal.close()
  await composer.fill('Still here')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Still here')
  expect(popups).toHaveLength(1)
})
