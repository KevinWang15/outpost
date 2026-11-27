const maxClipboardCopyBytes = 1024 * 1024
const maxClipboardCopyBase64 = Math.ceil(maxClipboardCopyBytes / 3) * 4

/** Encode a validated base64 clipboard payload from the private Xvfb display as an
 * OSC 52 sequence. Rejects empty, oversized, or non-base64 payloads so no stray
 * escape sequence can enter the terminal stream. */
export function clipboardOsc52(encoded: unknown): Buffer | null {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > maxClipboardCopyBase64 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return null
  const decodedBytes = (encoded.length / 4) * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
  if (decodedBytes <= 0 || decodedBytes > maxClipboardCopyBytes) return null
  return Buffer.from(`\x1b]52;c;${encoded}\x07`, 'ascii')
}
