import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  ALL_ONBOARDING_SCREENSHOT_FILES,
  ONBOARDING_STEPS,
  ONBOARDING_TERMS,
} from '../../frontend/onboarding/onboardingContent'
import { isOnboardingDismissed, readCompletedSteps } from '../../frontend/onboarding/onboardingState'

test('onboarding steps cover core concepts, native terminal install/connect, machines, and AI sessions without mentioning Chat', () => {
  assert.equal(ONBOARDING_STEPS.length, 6)
  const ids = ONBOARDING_STEPS.map(step => step.id)
  assert.deepEqual(ids, [
    'welcome',
    'install-desktop',
    'connect-desktop',
    'add-machine',
    'start-session',
    'connect-and-work',
  ])

  const termIds = ONBOARDING_TERMS.map(t => t.id)
  assert.ok(termIds.includes('machine'))
  assert.ok(termIds.includes('session'))
  assert.ok(termIds.includes('desktop'))
  assert.ok(termIds.includes('web-terminal'))
  assert.ok(termIds.includes('machine-cli'))

  // Ensure experimental Chat is never mentioned anywhere in onboarding copy, terms, or captions.
  const allCopy = JSON.stringify({ ONBOARDING_TERMS, ONBOARDING_STEPS })
  assert.doesNotMatch(allCopy, /\bchat\b/i, 'onboarding content must not mention experimental Chat')
})

test('onboarding state helpers are safe in non-browser environments', () => {
  assert.equal(isOnboardingDismissed(), false)
  assert.deepEqual(readCompletedSteps(), [])
})

test('every screenshot referenced by onboarding exists and is non-empty under docs/onboarding/', () => {
  const dir = join(process.cwd(), 'docs', 'onboarding')
  assert.ok(ALL_ONBOARDING_SCREENSHOT_FILES.length >= 8)
  for (const filename of ALL_ONBOARDING_SCREENSHOT_FILES) {
    const filePath = join(dir, filename)
    assert.ok(existsSync(filePath), `missing onboarding screenshot: docs/onboarding/${filename}`)
    assert.ok(statSync(filePath).size > 5_000, `onboarding screenshot looks empty: docs/onboarding/${filename}`)
  }
})
