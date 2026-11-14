import { expect, test } from '@playwright/test'
import { addClaudeTarget, newSession } from './chat-fixture'

test('a chat session follows its conversations, resumes an earlier one, and applies edits at the next start', async ({
  page,
}) => {
  await addClaudeTarget(page, 'Timeline box')
  await page.getByRole('navigation', { name: 'Mode' }).getByRole('link', { name: 'Chat' }).click()
  await newSession(page, 'Planner', '~/timeline-planner')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('First topic')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: First topic')

  // A new conversation in the same session, like /new in a terminal.
  const actions = page.getByRole('button', { name: 'Actions for Planner' })
  await actions.click()
  await page.getByRole('menuitem', { name: 'New conversation' }).click()
  await expect(page.locator('.transcript')).toContainText('Started a new conversation.')
  await composer.fill('Second topic')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: Second topic')

  // Both are in the session's timeline; resuming the first restarts the chat in it.
  await actions.click()
  await page.getByRole('menuitem', { name: 'Conversations' }).click()
  const timeline = page.getByRole('dialog', { name: 'Conversations in Planner' })
  const entries = timeline.getByRole('list', { name: 'Conversations' }).getByRole('listitem')
  await expect(entries).toHaveCount(2)
  await expect(entries.first()).toContainText('Second topic')
  await expect(entries.first()).toContainText('Current')
  await timeline.getByRole('button', { name: 'Resume First topic' }).click()
  await expect(timeline).toBeHidden()
  await expect(page.locator('.transcript')).toContainText('Fixture reply to: First topic')
  await expect(page.locator('.transcript')).not.toContainText('Second topic')

  // The name changes now; instructions apply when the chat next starts.
  await actions.click()
  await page.getByRole('menuitem', { name: 'Edit session' }).click()
  const settings = page.getByRole('dialog', { name: 'Edit Planner' })
  await settings.getByLabel('Name').fill('Release planner')
  await settings.getByLabel('Instructions').fill('Be brief.')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Release planner', level: 1 })).toBeVisible()
  const pending = page.locator('.status-card', { hasText: 'Changes apply at the next start.' })
  await expect(pending).toBeVisible()
  await pending.getByRole('button', { name: 'Restart now' }).click()
  await expect(pending).toBeHidden()
  await expect(page.locator('.transcript')).toContainText('Fixture reply to: First topic')
})

test('the workspace edits a session and lists its conversations', async ({ page }) => {
  await addClaudeTarget(page, 'Edit box')
  await page.getByRole('button', { name: 'New session' }).last().click()
  const create = page.getByRole('dialog', { name: 'New session' })
  await create.getByLabel('Name').fill('Builder')
  await create.getByRole('combobox', { name: 'Project directory' }).fill('~/edit-builder')
  await create.getByText('Create the directory if it doesn’t exist').click()
  await create.getByRole('button', { name: 'Create session' }).click()
  await expect(create).toBeHidden()

  await page.getByRole('button', { name: 'More actions for Builder' }).click()
  await page.getByRole('menuitem', { name: 'Edit session' }).click()
  const settings = page.getByRole('dialog', { name: 'Edit Builder' })
  await settings.getByLabel('Name').fill('Release builder')
  await settings.getByText('Model, MCP servers and launch').click()
  await settings.getByLabel('Arguments').fill('--model "$MODEL"')
  await settings.getByRole('button', { name: 'Add variable' }).click()
  await settings.getByLabel('Variable 1 name').fill('MODEL')
  await settings.getByLabel('Variable 1 value').fill('fixture')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings).toBeHidden()
  const row = page.getByRole('row').filter({ hasText: 'Release builder' })
  await expect(row).toBeVisible()

  // The saved configuration is what the dialog shows next time.
  await page.getByRole('button', { name: 'More actions for Release builder' }).click()
  await page.getByRole('menuitem', { name: 'Edit session' }).click()
  const again = page.getByRole('dialog', { name: 'Edit Release builder' })
  // Settings in use keep their section open.
  await expect(again.getByLabel('Arguments')).toHaveValue('--model "$MODEL"')
  await expect(again.getByLabel('Variable 1 name')).toHaveValue('MODEL')
  await expect(again.getByLabel('Variable 1 value')).toHaveValue('fixture')
  // Invalid arguments are refused with Bash's reason, and nothing changes.
  await again.getByLabel('Arguments').fill('"unclosed')
  await again.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(again.getByRole('alert')).toContainText('Invalid Bash argument syntax')
  await again.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'More actions for Release builder' }).click()
  await page.getByRole('menuitem', { name: 'Conversations' }).click()
  const timeline = page.getByRole('dialog', { name: 'Conversations in Release builder' })
  await expect(timeline.getByRole('listitem')).toHaveCount(1)
  await expect(timeline.getByRole('listitem')).toContainText('Current')
  await expect(timeline.getByRole('button', { name: /^Resume/ })).toHaveCount(0)
})

test('Edit source edits every setting as JSON, and a new session can copy them', async ({ page }) => {
  await addClaudeTarget(page, 'Source box')
  await page.getByRole('button', { name: 'New session' }).last().click()
  const create = page.getByRole('dialog', { name: 'New session' })
  await create.getByLabel('Name').fill('Reviewer')
  await create.getByRole('combobox', { name: 'Project directory' }).fill('~/source-reviewer')
  await create.getByText('Create the directory if it doesn’t exist').click()
  await create.getByLabel('Instructions').fill('You review pull requests.')
  await create.getByRole('button', { name: 'Create session' }).click()
  await expect(create).toBeHidden()

  await page.getByRole('button', { name: 'More actions for Reviewer' }).click()
  await page.getByRole('menuitem', { name: 'Edit session' }).click()
  const settings = page.getByRole('dialog', { name: 'Edit Reviewer' })
  await settings.getByRole('button', { name: 'Edit source' }).click()
  const source = settings.getByRole('textbox', { name: 'Settings source' })
  const shown = JSON.parse(await source.inputValue())
  expect(shown).toEqual({
    name: 'Reviewer',
    delivery: 'auto',
    instructions: 'You review pull requests.',
    model: null,
    mode: null,
    mcpServers: {},
    args: '',
    env: {},
  })
  // Mistakes are explained before anything is saved.
  await source.fill(JSON.stringify({ ...shown, extra: true }))
  await settings.getByRole('button', { name: 'Edit as form' }).click()
  await expect(settings.getByRole('alert')).toContainText('Unknown setting extra')
  await source.fill(JSON.stringify({ ...shown, mcpServers: { docs: { url: 'https://example.com/mcp' } } }))
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('MCP server docs needs a "command"')
  const edited = {
    ...shown,
    model: 'opus',
    mode: 'plan',
    mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp' } },
    env: { REVIEW: '1' },
  }
  await source.fill(JSON.stringify(edited, null, 2))
  // The form shows what the source said.
  await settings.getByRole('button', { name: 'Edit as form' }).click()
  await expect(settings.getByLabel('Model')).toHaveValue('opus')
  await expect(settings.getByLabel('Chat mode')).toHaveValue('plan')
  await expect(settings.getByLabel('MCP servers')).toHaveValue(/example\.com\/mcp/)
  await expect(settings.getByLabel('Variable 1 name')).toHaveValue('REVIEW')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings).toBeHidden()

  // A new session starts from the saved settings.
  await page.getByRole('button', { name: 'New session' }).last().click()
  const copy = page.getByRole('dialog', { name: 'New session' })
  await copy.getByLabel('Copy settings from').selectOption({ label: 'Reviewer · Claude Code' })
  await expect(copy.getByLabel('Instructions')).toHaveValue('You review pull requests.')
  await expect(copy.getByLabel('Model')).toHaveValue('opus')
  await copy.getByLabel('Name', { exact: true }).fill('Second reviewer')
  await copy.getByRole('combobox', { name: 'Project directory' }).fill('~/source-second')
  await copy.getByText('Create the directory if it doesn’t exist').click()
  await copy.getByRole('button', { name: 'Create session' }).click()
  await expect(copy).toBeHidden()

  await page.getByRole('button', { name: 'More actions for Second reviewer' }).click()
  await page.getByRole('menuitem', { name: 'Edit session' }).click()
  const second = page.getByRole('dialog', { name: 'Edit Second reviewer' })
  await second.getByRole('button', { name: 'Edit source' }).click()
  expect(JSON.parse(await second.getByRole('textbox', { name: 'Settings source' }).inputValue())).toEqual({
    ...edited,
    name: 'Second reviewer',
  })
})
