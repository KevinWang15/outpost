// Stroke icons for workspace chrome, drawn on the same 24px grid as the
// title-bar buttons in workspace.html so every control shares one weight.
const paths = {
  close: 'M18 6 6 18M6 6l12 12',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  maximize: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3',
  restore: 'M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3',
  draft: 'M12 12h.01',
}
export type ChromeIcon = keyof typeof paths

export function chromeIcon(name: ChromeIcon) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.dataset.icon = name
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

/** Swap a button's icon only when it changes, keeping hover and focus stable. */
export function setChromeIcon(button: HTMLElement, name: ChromeIcon) {
  if (button.querySelector('svg')?.dataset.icon === name) return
  button.replaceChildren(chromeIcon(name))
}
