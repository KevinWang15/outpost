import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalKey } from '../frontend/terminal-keyboard.ts'

test('terminal keys respect application cursor mode and encode modifiers for navigation and function keys', () => {
  assert.equal(terminalKey('ArrowUp'), '\x1b[A')
  assert.equal(terminalKey('ArrowUp', {}, true), '\x1bOA')
  assert.equal(terminalKey('Home', {}, true), '\x1bOH')
  assert.equal(terminalKey('ArrowLeft', { ctrl: true }, true), '\x1b[1;5D')
  assert.equal(terminalKey('ArrowRight', { ctrl: true, alt: true }), '\x1b[1;7C')
  assert.equal(terminalKey('Delete', { ctrl: true }), '\x1b[3;5~')
  assert.equal(terminalKey('PageDown'), '\x1b[6~')
  assert.equal(terminalKey('F1'), '\x1bOP')
  assert.equal(terminalKey('F4', { alt: true }), '\x1b[1;3S')
  assert.equal(terminalKey('F12', { ctrl: true }), '\x1b[24;5~')
})

test('printable keys, control characters and modified Enter preserve terminal conventions', () => {
  assert.equal(terminalKey('c', { ctrl: true }), '\x03')
  assert.equal(terminalKey('c', { ctrl: true, alt: true }), '\x1b\x03')
  assert.equal(terminalKey('b', { alt: true }), '\x1bb')
  assert.equal(terminalKey('Space', { ctrl: true }), '\0')
  assert.equal(terminalKey('Backspace'), '\x7f')
  assert.equal(terminalKey('Backspace', { ctrl: true }), '\b')
  assert.equal(terminalKey('Tab', { shift: true }), '\x1b[Z')
  assert.equal(terminalKey('Enter', { shift: true }), '\x1b[13;2u')
  assert.equal(terminalKey('Enter', { alt: true }), '\x1b\r')
  assert.equal(terminalKey('|'), '|')
  assert.equal(terminalKey('漢'), '漢')
  assert.equal(terminalKey('Control'), null)
  assert.equal(terminalKey('constructor'), null)
})
