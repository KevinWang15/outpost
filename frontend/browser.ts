export const touchInput = () => window.matchMedia('(pointer: coarse)').matches

export const standaloneBrowser = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

export const appleMobile = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isMac = () => /Mac/.test(navigator.platform)

export const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform)

export const copyText = (text: string) => navigator.clipboard.writeText(text)
