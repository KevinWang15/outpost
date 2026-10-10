/** Encode text as one paste using the remote application's negotiated mode. */
export function terminalPaste(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, '\r')
  return normalized && bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
}
