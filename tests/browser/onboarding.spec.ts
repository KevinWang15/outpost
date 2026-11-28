import { expect, test, type Page } from './fixtures'

const progress = (page: Page) => page.getByRole('progressbar', { name: 'Steps completed' })
const stepHeading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 })

test('the guide moves through its steps, remembers progress and follows browser history', async ({ page }) => {
  await page.goto('/onboarding')
  await expect(stepHeading(page, 'Welcome to Outpost')).toBeVisible()
  await expect(page).toHaveTitle('What is Outpost? · Getting started · Outpost')
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '0')
  await expect(page.getByRole('link', { name: 'Back', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/onboarding\?step=install-desktop$/)
  // The new step announces itself: focus moves to its heading.
  await expect(stepHeading(page, 'Install Outpost Desktop')).toBeFocused()
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '1')
  const steps = page.getByRole('navigation', { name: 'Getting started steps' })
  await expect(steps.getByRole('link', { name: 'What is Outpost? (done)' })).toBeVisible()
  await expect(steps.getByRole('link', { name: 'Install Outpost Desktop' })).toHaveAttribute('aria-current', 'step')

  await page.goBack()
  await expect(stepHeading(page, 'Welcome to Outpost')).toBeVisible()
  await page.goForward()
  await expect(stepHeading(page, 'Install Outpost Desktop')).toBeVisible()

  await page.getByRole('link', { name: 'Skip to adding a machine' }).click()
  await expect(stepHeading(page, 'Add a machine')).toBeVisible()
  await page.reload()
  await expect(stepHeading(page, 'Add a machine')).toBeVisible()
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '1')

  await page.goto('/onboarding?step=connect-and-work')
  await page.getByRole('button', { name: 'Finish and open Machines' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Run your coding agents on your own machines' })).toBeVisible()
})

test('screenshots switch by tab and enlarge in a dialog that hands focus back', async ({ page }) => {
  await page.goto('/onboarding?step=connect-desktop')
  const tabs = page.getByRole('tablist', { name: 'Screenshots' })
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(tabs.getByRole('tab', { name: 'In the app' })).toHaveAttribute('aria-selected', 'true')

  await tabs.getByRole('tab', { name: 'In your browser' }).click()
  await expect(page.getByRole('tabpanel', { name: 'In your browser' })).toContainText('The approval page')
  await expect(page.getByRole('img', { name: /Connect Outpost Desktop\?/ })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Connected' })).toBeFocused()
  await expect(tabs.getByRole('tab', { name: 'Connected' })).toHaveAttribute('aria-selected', 'true')

  const frame = page.getByRole('button', { name: 'Enlarge screenshot: Connected' })
  await frame.click()
  await expect(page.getByRole('dialog', { name: 'Screenshot: Connected' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: 'Screenshot: In the app' })).toContainText('1 of 3')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The tabs follow the picture that was last enlarged, and focus returns to the frame.
  await expect(tabs.getByRole('tab', { name: 'In the app' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Enlarge screenshot: In the app' })).toBeFocused()

  // A step with one screenshot has no tabs.
  await page.goto('/onboarding?step=welcome')
  await expect(page.getByRole('button', { name: 'Enlarge screenshot: Machines' })).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)
})

test('the guide reflects connected machines and Machines offers to resume it', async ({ page, request }) => {
  const banner = page.getByRole('region', { name: 'Getting started' })

  // With no machine, the welcome is the way in and the session step says what is missing.
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Getting started guide' })).toBeVisible()
  await expect(banner).toHaveCount(0)
  await page.goto('/onboarding?step=start-session')
  await expect(page.getByText('Sessions need a machine to run on.')).toBeVisible()
  await page.goto('/onboarding?step=add-machine')
  const addMachine = page.getByRole('main').getByRole('link', { name: 'Add a machine', exact: true })
  await expect(addMachine).toHaveAttribute('href', '/?add=1')

  const added = await request.post('/api/targets', {
    headers: { 'x-outpost-request': '1' },
    data: { kind: 'local', name: 'Guide box' },
  })
  expect(added.status()).toBe(201)

  await page.goto('/')
  await expect(banner).toContainText('New to Outpost?')
  await banner.getByRole('link', { name: 'Open the guide' }).click()
  await expect(stepHeading(page, 'Welcome to Outpost')).toBeVisible()

  // A connected machine completes its step without the reader marking anything.
  await page.goto('/onboarding?step=add-machine')
  await expect(page.getByText('Guide box is already connected.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add another machine' })).toBeVisible()
  await expect(progress(page)).toHaveAttribute('aria-valuenow', '1')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(stepHeading(page, 'Start a session')).toBeVisible()
  await expect(page.getByText('Sessions need a machine to run on.')).toHaveCount(0)

  await page.goto('/')
  await expect(banner).toContainText('1 of 6 steps done')
  await expect(banner.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/onboarding?step=welcome')
  await banner.getByRole('button', { name: 'Dismiss getting started' }).click()
  await expect(banner).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Guide box', level: 1 })).toBeVisible()
  await expect(banner).toHaveCount(0)
})
