import { pagePaths } from './pages.ts'

/** Set the terminal theme before first paint, including while React chunks load. */
export function pageHtml(html: string, pathname: string) {
  if (pathname !== pagePaths.desktopTerminal) return html
  return html
    .replace('<html ', '<html data-theme="terminal" ')
    .replace('name="color-scheme" content="light"', 'name="color-scheme" content="dark"')
    .replace('name="theme-color" content="#f7f9fc"', 'name="theme-color" content="#0f172a"')
}
