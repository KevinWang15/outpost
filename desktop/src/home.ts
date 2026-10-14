import type { HomeBridge } from './home-api'

declare global {
  interface Window {
    outpostHome: HomeBridge
  }
}
const api = window.outpostHome
const form = document.querySelector<HTMLFormElement>('form')!
const input = document.querySelector<HTMLInputElement>('input')!
const submit = document.querySelector<HTMLButtonElement>('button[type=submit]')!
const status = document.querySelector<HTMLElement>('[role=status]')!
const servers = document.querySelector<HTMLUListElement>('#servers')!
async function refresh() {
  const state = await api.status()
  document.querySelector('#version')!.textContent = `Preview ${state.version}`
  servers.replaceChildren()
  for (const origin of state.servers) {
    const row = document.createElement('li')
    const open = document.createElement('button')
    open.className = 'server'
    open.textContent = origin
    open.onclick = () => {
      input.value = origin
      form.requestSubmit()
    }
    const forget = document.createElement('button')
    forget.textContent = 'Forget'
    forget.setAttribute('aria-label', `Forget ${origin} and close its terminals`)
    forget.onclick = async () => {
      forget.disabled = true
      try {
        await api.forgetServer(origin)
        await refresh()
      } catch {
        status.textContent = 'Could not forget this server.'
        forget.disabled = false
      }
    }
    row.append(open, forget)
    servers.append(row)
  }
}
form.onsubmit = async event => {
  event.preventDefault()
  submit.disabled = true
  status.textContent = ''
  try {
    if (await api.openServer(input.value.trim())) {
      status.textContent = 'Choose a session in your browser, then Connect → Outpost Desktop.'
      await refresh()
    }
  } catch {
    status.textContent = 'Could not open this server. Use HTTPS, or HTTP on localhost, and check your connection.'
  } finally {
    submit.disabled = false
  }
}
document.querySelector<HTMLButtonElement>('#updates')!.onclick = () => {
  void api.checkUpdates()
}
window.addEventListener('focus', () => {
  void refresh().catch(() => {})
})
void refresh().catch(() => {
  status.textContent = 'Could not load your server list.'
})
