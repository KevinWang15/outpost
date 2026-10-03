import { AppError } from './errors'

export interface AccountEmail { to: string; subject: string; html: string }
export type AccountMailer = (message: AccountEmail) => Promise<void>
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export function accountEmail(name: string, email: string, url: string, purpose: 'verify' | 'reset'): AccountEmail {
  const verify = purpose === 'verify'
  const title = verify ? 'Verify your Outpost email' : 'Reset your Outpost password'
  return {
    to: email, subject: title,
    html: `<div style="font:16px/1.6 Arial,sans-serif;max-width:600px;margin:auto;color:#17253b"><h1 style="font-size:24px">${title}</h1><p>Hello ${escape(name)},</p><p>${verify ? 'Confirm your email to open your private coding workspace.' : 'Use this link to choose a new password. Your existing sign-ins will be revoked.'}</p><p><a style="display:inline-block;padding:12px 20px;background:#2563eb;color:white;border-radius:8px;text-decoration:none" href="${escape(url)}">${verify ? 'Verify email' : 'Reset password'}</a></p><p>This link expires in ${verify ? '24 hours' : 'one hour'} and can be used once.</p><p>If you did not request this, you can ignore this email.</p><p style="font-size:13px;word-break:break-all">${escape(url)}</p></div>`,
  }
}
export function engageLabMailer(env: NodeJS.ProcessEnv = process.env): AccountMailer | null {
  const { ENGAGE_LAB_USERNAME: username, ENGAGE_LAB_API_KEY: apiKey, ENGAGE_LAB_FROM_EMAIL: from } = env
  if (!username || !apiKey || !from) return null
  return async message => {
    const response = await fetch('https://email.api.engagelab.cc/v1/mail/send', {
      method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}` },
      body: JSON.stringify({ from, to: [message.to], body: { subject: message.subject, content: { html: message.html } } }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new AppError('Email delivery failed. Please try resending the link later.', 502) }
    await response.body?.cancel()
  }
}
