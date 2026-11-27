// Browser entry points, also used by the production SPA fallback.
export const pagePaths = {
  workspace: '/',
  chat: '/chat',
  logs: '/logs',
  onboarding: '/onboarding',
  guide: '/guide',
  terminal: '/terminal',
  desktop: '/desktop',
  desktopAuthorize: '/desktop/authorize',
  login: '/login',
  signup: '/signup',
  verifyEmail: '/verify-email',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
} as const

export const isGuidePath = (pathname: string) =>
  pathname === pagePaths.guide || pathname.startsWith(`${pagePaths.guide}/`)

export const isProtectedWorkspacePath = (pathname: string) =>
  pathname === pagePaths.workspace ||
  pathname === pagePaths.chat ||
  pathname === pagePaths.terminal ||
  pathname === pagePaths.logs ||
  pathname === pagePaths.onboarding ||
  isGuidePath(pathname)
