import assert from 'node:assert/strict'
import test from 'node:test'
import { chatNavigationAllowed, chatPageUrl, validChatTicket } from '../../desktop/src/chat-policy'

test('desktop chat window: only its server chat page, and tickets for its own account', () => {
  const origin = 'https://outpost.example.com'
  assert.equal(chatPageUrl(origin), 'https://outpost.example.com/chat/desktop')
  assert.equal(chatNavigationAllowed(origin, `${origin}/chat/desktop?target=a&session=b`), true)
  for (const url of [
    `${origin}/chat`,
    `${origin}/`,
    `${origin}/terminal/desktop`,
    'https://evil.example.com/chat/desktop',
    'https://user:pass@outpost.example.com/chat/desktop',
    'javascript:alert(1)',
  ])
    assert.equal(chatNavigationAllowed(origin, url), false, url)
  const ticket = { server: origin, accountId: 'a1', ticket: 'x.y', protocol: 1 }
  assert.equal(validChatTicket(ticket, origin, 'a1'), true)
  assert.equal(validChatTicket({ ...ticket, accountId: 'other' }, origin, 'a1'), false)
  assert.equal(validChatTicket({ ...ticket, server: 'https://other.example.com' }, origin, 'a1'), false)
  assert.equal(validChatTicket({ ...ticket, ticket: '' }, origin, 'a1'), false)
})
