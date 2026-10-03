export const expectedKeyboardInput = 'A\x1b[13;2uB\x1b[13;2uC\r\x03\x1a\x0cOUTPOST_KEYS_END'

// Mode 2 can encode these control keys as CSI u. Verify their meaning while
// rejecting modifyOtherKeys output or any missing/duplicated input.
export function normalizeKeyboardControls(input) {
  return input.replaceAll('\x1b[99;5u', '\x03').replaceAll('\x1b[122;5u', '\x1a').replaceAll('\x1b[108;5u', '\x0c')
}
