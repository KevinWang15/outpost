import type { WorkspaceBridge } from './workspace-api'
import type {
  ServerAccountSummary,
  ServerAccountsSnapshot,
  ServerConnection,
  ServerSignInSummary,
  SignInPhase,
} from './server-accounts-api'
import { reconcileElements } from './keyed-elements'

const labels: Record<ServerConnection, string> = {
  checking: 'Checking…',
  connected: 'Connected',
  offline: 'Offline',
  expired: 'Connect',
  'signing-out': 'Signing out…',
}
const icons: Record<ServerConnection, string> = {
  checking: 'M12 3a9 9 0 1 1-9 9',
  connected: 'M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  offline: 'M3 3l18 18M8 3v4M16 3v4M7 7H6v4a6 6 0 0 0 10 4M18 11V7h-5M12 17v4',
  expired: 'M12 7v6M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  'signing-out': 'M12 3a9 9 0 1 1-9 9',
}
const progress: Record<SignInPhase, string> = {
  opening: 'Opening your browser…',
  waiting: 'Finish sign-in in your browser.',
  exchanging: 'Completing sign-in…',
  saving: 'Saving your login…',
}

/** Durable accounts and transient sign-in feedback have distinct data contracts. */
export function serverAccountsControls(api: WorkspaceBridge, run: (work: Promise<unknown>) => void) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
  const accounts = new Map<string, HTMLElement>(),
    signIns = new Map<string, HTMLElement>()
  const button = (label: string, className = 'subtle') => {
    const node = document.createElement('button')
    node.type = 'button'
    node.textContent = label
    node.className = className
    return node
  }
  function accountRow() {
    const row = document.createElement('li')
    row.className = 'server-account'
    const info = document.createElement('div')
    info.className = 'row-main'
    info.append(document.createElement('strong'), document.createElement('small'))
    const status = button('', 'server-status')
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('aria-hidden', 'true')
    icon.append(document.createElementNS(icon.namespaceURI, 'path'))
    status.append(icon, document.createElement('span'))
    row.append(info, status, button('New session', 'subtle server-create'), button('Sign out', 'subtle server-signout'))
    return row
  }
  function updateAccount(row: HTMLElement, server: ServerAccountSummary, pending: boolean) {
    row.dataset.status = server.status
    row.querySelector('strong')!.textContent = server.origin
    row.querySelector('small')!.textContent =
      server.error ?? `${server.account.name}${server.account.email ? ' · ' + server.account.email : ''}`
    const status = row.querySelector<HTMLButtonElement>('.server-status')!
    status.querySelector('path')!.setAttribute('d', icons[server.status])
    status.querySelector('span')!.textContent = labels[server.status]
    status.disabled = pending || server.status === 'checking' || server.status === 'signing-out'
    status.title = server.status === 'expired' ? 'Sign in using your browser' : 'Check server connection'
    status.setAttribute('aria-label', `${status.textContent} · ${server.origin}`)
    status.onclick = () => run(server.status === 'expired' ? api.loginServer(server.origin) : api.refreshServers())
    const create = row.querySelector<HTMLButtonElement>('.server-create')!
    create.disabled = pending || server.status === 'expired' || server.status === 'signing-out'
    create.onclick = () => run(api.openOutpostTerminal(server.origin))
    create.setAttribute('aria-label', `New session on ${server.origin}`)
    const signout = row.querySelector<HTMLButtonElement>('.server-signout')!
    signout.disabled = pending || server.status === 'signing-out'
    signout.onclick = () => run(api.logoutServer(server.origin))
    signout.setAttribute('aria-label', `Sign out of ${server.origin}`)
  }
  function signInRow() {
    const row = document.createElement('div')
    row.className = 'server-sign-in'
    row.append(document.createElement('span'), button('Cancel sign-in'))
    return row
  }
  function updateSignIn(row: HTMLElement, attempt: ServerSignInSummary) {
    row.querySelector('span')!.textContent = `${attempt.origin} · ${progress[attempt.phase]}`
    const cancel = row.querySelector('button')!
    cancel.disabled = attempt.phase === 'saving'
    cancel.setAttribute('aria-label', `Cancel sign-in to ${attempt.origin}`)
    cancel.onclick = () => run(api.cancelServerLogin(attempt.origin))
  }
  el<HTMLFormElement>('server-form').onsubmit = async event => {
    event.preventDefault()
    const submit = el('server-form').querySelector<HTMLButtonElement>('button[type=submit]')!
    submit.disabled = true
    el('open-result').textContent = ''
    try {
      await api.loginServer(el<HTMLInputElement>('server').value.trim())
    } catch (error) {
      el('open-result').textContent = error instanceof Error ? error.message : 'Could not start sign-in.'
    } finally {
      submit.disabled = false
    }
  }
  el('refresh-servers').onclick = () => run(api.refreshServers())
  return (snapshot: ServerAccountsSnapshot) => {
    const pending = new Set(snapshot.signIns.map(attempt => attempt.origin))
    reconcileElements(
      el('servers'),
      accounts,
      snapshot.accounts,
      server => server.origin,
      accountRow,
      (row, server) => updateAccount(row, server, pending.has(server.origin)),
    )
    reconcileElements(
      el('server-signins'),
      signIns,
      snapshot.signIns,
      attempt => attempt.origin,
      signInRow,
      updateSignIn,
    )
    el('no-servers').hidden = snapshot.accounts.length > 0
  }
}
