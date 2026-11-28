import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  ALL_ONBOARDING_SCREENSHOT_FILES,
  ONBOARDING_SHORTCUTS,
  ONBOARDING_STEPS,
  ONBOARDING_TERMS,
} from '../../frontend/onboarding/onboardingContent'
import {
  isOnboardingDismissed,
  nextOnboardingStep,
  onboardingHref,
  parseCompletedSteps,
  readCompletedSteps,
} from '../../frontend/onboarding/onboardingState'

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
  const allCopy = JSON.stringify({ ONBOARDING_TERMS, ONBOARDING_STEPS, ONBOARDING_SHORTCUTS })
  assert.doesNotMatch(allCopy, /\bchat\b/i, 'onboarding content must not mention experimental Chat')
})

test('every onboarding step has a screenshot with a tab label, alt text and a caption', () => {
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.screenshots.length > 0, `${step.id} has no screenshot`)
    const labels = step.screenshots.map(shot => shot.label)
    assert.equal(new Set(labels).size, labels.length, `${step.id} repeats a screenshot tab label`)
    for (const shot of step.screenshots) {
      assert.ok(shot.label && shot.alt && shot.caption, `${step.id}/${shot.filename} is missing text`)
      assert.notEqual(shot.alt, shot.caption, `${step.id}/${shot.filename} repeats its caption as alt text`)
      if (!shot.focus) continue
      // A focus point outside the picture or a zoom below 1 would show empty space in the frame.
      assert.ok(shot.focus.zoom >= 1 && shot.focus.zoom <= 2, `${step.id}/${shot.filename} zoom`)
      for (const edge of [shot.focus.x, shot.focus.y])
        assert.ok(edge >= 0 && edge <= 100, `${step.id}/${shot.filename} focus point`)
    }
  }
})

test('onboarding shortcuts give a macOS and a Windows form for each action', () => {
  const ids = ONBOARDING_SHORTCUTS.map(shortcut => shortcut.id)
  assert.equal(new Set(ids).size, ids.length)
  // The sessions picker is the one shortcut a step refers to by id.
  assert.ok(ids.includes('sessions-picker'))
  for (const shortcut of ONBOARDING_SHORTCUTS) {
    assert.ok(shortcut.mac.includes('⌘'), `${shortcut.id} macOS form`)
    assert.ok(shortcut.other.includes('Ctrl'), `${shortcut.id} Windows form`)
  }
})

test('onboarding state helpers are safe in non-browser environments', () => {
  assert.equal(isOnboardingDismissed(), false)
  assert.deepEqual(readCompletedSteps(), [])
})

test('stored onboarding progress keeps only real steps, once each, in guide order', () => {
  assert.deepEqual(parseCompletedSteps(null), [])
  assert.deepEqual(parseCompletedSteps('not json'), [])
  assert.deepEqual(parseCompletedSteps('{"welcome":true}'), [])
  assert.deepEqual(parseCompletedSteps(JSON.stringify(['start-session', 'welcome', 'removed-step', 7, 'welcome'])), [
    'welcome',
    'start-session',
  ])
})

test('the guide resumes at the first step that is not done', () => {
  assert.equal(nextOnboardingStep([]), 'welcome')
  assert.equal(nextOnboardingStep(['welcome', 'install-desktop', 'add-machine']), 'connect-desktop')
  assert.equal(nextOnboardingStep(ONBOARDING_STEPS.map(step => step.id)), null)
  assert.equal(onboardingHref('add-machine'), '/onboarding?step=add-machine')
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
