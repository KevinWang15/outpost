import { useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { ArrowRight, CheckCircle2, Eye, EyeOff, Mail, ShieldCheck, Terminal } from 'lucide-react'
import type { AuthMessage } from '../shared/auth'
import { api, ApiError } from './api'
import { useAuth } from './useAuth'

function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  const { navigate } = useAuth()
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault(); navigate(href)
  }
  return <a href={href} onClick={follow}>{children}</a>
}
export default function AuthPage({ path }: { path: string }) {
  const { refresh, navigate } = useAuth()
  const kind = path === '/signup' ? 'signup' : path === '/verify-email' ? 'verify' : path === '/forgot-password' ? 'forgot' : path === '/reset-password' ? 'reset' : 'login'
  const parameters = new URLSearchParams(window.location.search)
  const token = parameters.get('token') ?? ''
  const [email, setEmail] = useState(parameters.get('email') ?? '')
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [unverified, setUnverified] = useState(false)
  const [message, setMessage] = useState(parameters.has('created') ? 'Account created. Check your email for a verification link.' : '')
  const [devUrl, setDevUrl] = useState('')
  const [complete, setComplete] = useState(false)
  const titles = { login: 'Welcome back.', signup: 'Give your work a home.', verify: 'Verify your email.', forgot: 'Forgot your password?', reset: 'Choose a new password.' }
  const subtitles = { login: 'Sign in to pick up your coding sessions.', signup: 'Your own workspace for AI sessions across your dev servers.', verify: token ? 'Confirm your email to open your Outpost workspace.' : 'Open the link in your inbox, or request a fresh one below.', forgot: 'We’ll email you a link to reset it.', reset: 'Use at least 8 characters to protect your workspace.' }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setUnverified(false); setBusy(true)
    try {
      if ((kind === 'signup' || kind === 'reset') && password !== confirmation) throw new Error('Passwords do not match.')
      const address = email.trim().toLowerCase()
      if (kind === 'login') {
        await api('/auth/login', 'POST', { email: address, password })
        await refresh(); navigate('/')
      } else if (kind === 'signup') {
        const result = await api<AuthMessage>('/auth/signup', 'POST', { email: address, name: name.trim(), password })
        setPassword(''); setConfirmation(''); setComplete(true); setMessage(result.message); setDevUrl(result.devUrl ?? '')
      } else if (kind === 'verify' && token) {
        await api('/auth/verify-email', 'POST', { token })
        await refresh(); navigate('/')
      } else if (kind === 'reset') {
        if (!token) throw new Error('Open the password reset link from your email.')
        const result = await api<AuthMessage>('/auth/reset-password', 'POST', { token, password })
        setComplete(true); setPassword(''); setConfirmation(''); setMessage(result.message)
      } else {
        const result = await api<AuthMessage>(kind === 'forgot' ? '/auth/forgot-password' : '/auth/resend-verification', 'POST', { email: address })
        setMessage(result.message); setDevUrl(result.devUrl ?? '')
      }
    } catch (problem) {
      setError((problem as Error).message)
      setUnverified(problem instanceof ApiError && problem.code === 'EMAIL_NOT_VERIFIED')
    } finally { setBusy(false) }
  }
  const fields = !complete && (kind !== 'verify' || !token)
  const needsEmail = kind !== 'reset' && !(kind === 'verify' && token)
  const needsPassword = ['login', 'signup', 'reset'].includes(kind)
  return <div className="auth-shell">
    <div className="auth-story">
      <a className="brand" href="/"><img className="brand-mark" src="/outpost.svg" width="42" height="42" alt="" /><span>Outpost<span className="brand-sub">AI Session Manager</span></span></a>
      <div className="auth-story-copy"><span className="eyebrow">KEEP THE SESSION. KEEP YOUR FLOW.</span><h1>Your work keeps going.<br />Come back from anywhere.</h1><p>One place for Codex, Claude Code, and Kimi sessions across your development servers.</p>
        <div className="auth-story-feature"><Terminal /><span><strong>Pick up where you left off.</strong>Your agents keep running when your terminal closes.</span></div>
        <div className="auth-story-feature"><ShieldCheck /><span><strong>A workspace of your own.</strong>Your servers, your sessions, and your account.</span></div>
      </div>
      <p className="auth-story-footer">Built for the way you code.</p>
    </div>
    <main className="auth-main"><div className="auth-card">
      <span className="eyebrow">YOUR OUTPOST WORKSPACE</span><h2>{titles[kind]}</h2><p className="auth-subtitle">{subtitles[kind]}</p>
      {message && <div className="auth-message" role="status"><CheckCircle2 /><p>{message}</p></div>}
      {devUrl && <div className="auth-dev-link"><strong>Local development email</strong><p>Email delivery is simulated for this local instance.</p><AuthLink href={new URL(devUrl).pathname + new URL(devUrl).search}>{kind === 'forgot' ? 'Open password reset link' : 'Open verification link'} <ArrowRight size={14} /></AuthLink></div>}
      <form onSubmit={submit}>
        {fields && <>
          {kind === 'signup' && <label>Name<input required name="name" autoComplete="name" value={name} maxLength={80} onChange={event => setName(event.target.value)} autoFocus placeholder="Your name" /></label>}
          {needsEmail && <label>Email<input required type="email" name="email" autoComplete="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} autoFocus={kind !== 'signup'} placeholder="you@example.com" /></label>}
          {needsPassword && <label>Password<div className="password-field"><input required type={showPassword ? 'text' : 'password'} name="password" autoComplete={kind === 'login' ? 'current-password' : 'new-password'} minLength={kind === 'login' ? 1 : 8} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} placeholder={kind === 'login' ? 'Your password' : 'At least 8 characters'} /><button type="button" className="icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff /> : <Eye />}</button></div></label>}
          {(kind === 'signup' || kind === 'reset') && <label>Confirm password<input required type={showPassword ? 'text' : 'password'} name="confirmation" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="Repeat your password" /></label>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        {unverified && <p className="auth-recovery"><AuthLink href={`/verify-email?email=${encodeURIComponent(email)}`}>Resend verification email</AuthLink></p>}
        {!complete && <button className="button primary auth-submit" disabled={busy || (kind === 'reset' && !token)}>{busy ? 'Please wait…' : kind === 'signup' ? 'Create account' : kind === 'verify' ? token ? 'Verify email' : 'Resend verification email' : kind === 'forgot' ? 'Send reset link' : kind === 'reset' ? 'Reset password' : 'Sign in'}{kind === 'verify' || kind === 'forgot' ? <Mail /> : <ArrowRight />}</button>}
      </form>
      <div className="auth-links">
        {kind === 'signup' && complete && <p><AuthLink href={`/verify-email?email=${encodeURIComponent(email)}`}>Resend verification email</AuthLink></p>}
        {kind === 'login' ? <><AuthLink href="/forgot-password">Forgot password?</AuthLink><p>New to Outpost? <AuthLink href="/signup">Create an account</AuthLink></p></> : <p><AuthLink href="/login">Back to sign in</AuthLink>{kind === 'reset' && !token && <> · <AuthLink href="/forgot-password">Request a reset link</AuthLink></>}</p>}
      </div>
    </div></main>
  </div>
}
