import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { chromium, expect as browserExpect } from '@playwright/test'

const execute = promisify(execFile)
const expect = browserExpect.configure({ timeout: 20_000 })
const project = fileURLToPath(new URL('../', import.meta.url))
const fixtures = join(project, 'tests/fixtures')
const docker = async (...args) => (await execute('docker', args, {
  timeout: 240_000, maxBuffer: 4_000_000,
  env: { ...process.env, http_proxy: process.env.http_proxy ?? process.env.HTTP_PROXY, https_proxy: process.env.https_proxy ?? process.env.HTTPS_PROXY },
})).stdout.trim()
async function until(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result } catch { /* Services may still be starting. */ }
    await delay(200)
  }
  assert.fail(`Timed out: ${description}`)
}
const headers = { 'x-outpost-request': '1' }
async function availablePort() {
  const server = createServer()
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
async function api(context, method, origin, path, data, status = 200) {
  const response = await context.request.fetch(`${origin}/api${path}`, { method, headers, ...(data === undefined ? {} : { data }) })
  assert.equal(response.status(), status, `${method} ${path}: ${await response.text()}`)
  return status === 204 ? null : response.json()
}

test('real deployments: default local desktop/local/SSH sessions and production hosted HTTPS/email/accounts/mobile SSH', { timeout: 900_000 }, async t => {
  assert.equal(process.platform, 'linux', 'Local containers use host networking for the loopback-only local manager')
  const directory = await mkdtemp(join(tmpdir(), 'outpost-deployment-'))
  const prefix = `outpost-deployment-${process.pid}-${Date.now()}`
  const network = `${prefix}-net`, containers = []
  const state = join(directory, 'hosted-state'), localState = join(directory, 'local-state')
  let browser, networkCreated = false, imageBuilt = false
  t.after(async () => {
    await browser?.close()
    for (const name of containers.reverse()) await docker('rm', '-f', name).catch(() => {})
    if (networkCreated) await docker('network', 'rm', network)
    // Containers own private 0700/0600 state. Clean it inside a container so
    // this also works for an ordinary non-root CI runner.
    if (imageBuilt) await docker('run', '--rm', '--network', 'none', '--mount', `type=bind,source=${directory},target=/cleanup`, 'outpost-deployment-test:local', 'node', '-e', "const fs=require('node:fs'); for(const name of fs.readdirSync('/cleanup')) fs.rmSync('/cleanup/'+name,{recursive:true,force:true})")
    await rm(directory, { recursive: true, force: true })
  })
  const run = async (name, args, image, command = []) => {
    const full = `${prefix}-${name}`
    await docker('run', '-d', '--init', '--name', full, '--label', `outpost.test=${prefix}`, ...args, image, ...command)
    containers.push(full)
    return full
  }
  const port = async (container, internal) => Number((await docker('port', container, internal)).split(':').at(-1))
  const volume = (source, destination, readonly = true) => ['--mount', `type=bind,source=${source},target=${destination}${readonly ? ',readonly' : ''}`]
  const modules = volume(join(project, 'node_modules'), '/app/node_modules')
  await mkdir(state); await mkdir(localState)
  await cp(join(project, 'dist'), join(directory, 'dist'), { recursive: true })
  await copyFile(join(project, 'package.json'), join(directory, 'package.json'))
  await copyFile('/etc/ssl/certs/ca-certificates.crt', join(directory, 'certificates.crt'))
  await copyFile(join(fixtures, 'coding-tool-fixture.py'), join(directory, 'coding-tool-fixture.py'))
  // Docker's predefined proxy build arguments stay out of the image configuration.
  // Host networking also lets a configured loopback package proxy be reached.
  const proxyArgs = ['http_proxy', 'https_proxy'].flatMap(name => process.env[name] || process.env[name.toUpperCase()] ? ['--build-arg', name] : [])
  await docker('build', '--network', 'host', ...proxyArgs, '-f', join(fixtures, 'Dockerfile.deployment'), '-t', 'outpost-deployment-test:local', directory)
  imageBuilt = true
  await docker('network', 'create', network); networkCreated = true
  const targets = {}
  for (const name of ['alice', 'bob']) {
    const container = await run(name, ['--network', network, '--network-alias', `${name}-ssh`, '-p', '127.0.0.1::22'], 'outpost-deployment-test:local', ['sh', '-c', 'ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no'])
    targets[name] = { container, port: await port(container, '22') }
  }
  const plainKey = join(directory, 'local-key'), webKey = join(directory, 'web-key')
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', plainKey])
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'fixture-passphrase', '-f', webKey])
  await docker('cp', `${plainKey}.pub`, `${targets.alice.container}:/root/.ssh/authorized_keys`)
  await docker('cp', `${webKey}.pub`, `${targets.alice.container}:/tmp/web.pub`)
  await docker('exec', targets.alice.container, 'sh', '-c', 'cat /tmp/web.pub >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys')

  browser = await chromium.launch()
  const local = await browser.newContext(), desktopPage = await local.newPage()
  const localManager = await run('local', [
    '--network', 'host', ...modules, ...volume(localState, '/state', false), ...volume(plainKey, '/test/local-key'),
    '-e', 'NODE_ENV=production', '-e', 'HOST=127.0.0.1', '-e', 'PORT=0', '-e', 'OUTPOST_DATA_DIR=/state',
  ], 'outpost-deployment-test:local', ['xvfb-run', '-a', '-n', String(1000 + process.pid % 1000), 'node', 'dist/server/server.js'])
  const localOrigin = await until(async () => (await docker('logs', localManager)).match(/^Server listening at (http:\/\/[^\s]+)$/m)?.[1], 'local startup')
  let localTarget, remoteTarget, desktopSession
  await t.test('local is the default; the real UI launches local and SSH sessions in XTerm without login', async () => {
    assert.deepEqual(await api(local, 'GET', localOrigin, '/auth/session'), { mode: 'local', user: null })
    assert.equal((await local.request.get(`${localOrigin}/api/account/ssh-key`)).status(), 404)
    await desktopPage.goto(localOrigin)
    await expect(desktopPage.getByRole('button', { name: 'Add your first target' })).toBeVisible()
    await expect(desktopPage.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
    await expect(desktopPage.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
    localTarget = await api(local, 'POST', localOrigin, '/targets', { kind: 'local', name: 'Container desktop', backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'] }, 201)
    remoteTarget = await api(local, 'POST', localOrigin, '/targets', { kind: 'ssh', name: 'Remote desktop target', host: '127.0.0.1', port: targets.alice.port, identityFile: '/test/local-key', backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'] }, 201)
    for (const [target, backend, tool, executionHost] of [
      [localTarget, 'tmux', 'codex', localManager], [remoteTarget, 'dtach', 'kimi', targets.alice.container],
    ]) {
      const report = await api(local, 'GET', localOrigin, `/targets/${target.id}/software`)
      assert.ok(report.software.every(item => item.status === 'installed'), JSON.stringify(report))
      const root = `/root/desktop-${backend}`
      const session = await api(local, 'POST', localOrigin, `/targets/${target.id}/sessions`, { backend, tool, name: `Desktop ${backend}`, rootDir: root, createDirectory: true }, 201)
      await docker('exec', executionHost, 'touch', `${root}/capture-input`)
      await desktopPage.goto(`${localOrigin}/?target=${target.id}`)
      await desktopPage.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(desktopPage.locator('.toast')).toContainText('XTerm')
      const heartbeat = await until(async () => JSON.parse(await docker('exec', executionHost, 'cat', `${root}/heartbeat.json`)), 'real desktop connection')
      assert.equal(heartbeat.tool, tool); assert.equal(heartbeat.cliSessionId, session.cliSessionId)
      await expect(desktopPage.getByRole('dialog')).toHaveCount(0)
      if (target.kind === 'ssh') desktopSession = { session, root, pid: heartbeat.pid }
    }
    const localFiles = JSON.parse(await docker('exec', localManager, 'node', '-e', "console.log(JSON.stringify(require('node:fs').readdirSync('/state')))"))
    assert.equal(localFiles.some(name => name.startsWith('accounts.sqlite') || name === 'users'), false)
    await mkdir(join(project, 'test-results'), { recursive: true })
    await desktopPage.screenshot({ path: join(project, 'test-results/deployment-local.png'), fullPage: true })
  })
  await t.test('the remote coding session survives stopping the local deployment', async () => {
    await docker('stop', '-t', '15', localManager)
    const heartbeat = JSON.parse(await docker('exec', targets.alice.container, 'cat', `${desktopSession.root}/heartbeat.json`))
    assert.equal(heartbeat.pid, desktopSession.pid)
    assert.equal(await docker('exec', targets.alice.container, 'cat', `${desktopSession.root}/starts.log`), String(desktopSession.pid))
  })

  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', '/CN=outpost-container-test', '-addext', 'subjectAltName=DNS:email.api.engagelab.cc,IP:127.0.0.1'])
  const mail = await run('mail', ['--network', network, '--network-alias', 'email.api.engagelab.cc', '-p', '127.0.0.1::80', ...volume(directory, '/fixtures'), ...volume(join(fixtures, 'mail-service.mjs'), '/mail-service.mjs')], 'node:24-bookworm-slim', ['node', '/mail-service.mjs'])
  const inbox = `http://127.0.0.1:${await port(mail, '80')}/messages`
  const nginx = join(directory, 'nginx.conf')
  await writeFile(nginx, `events {}\nhttp {
    resolver 127.0.0.11 valid=1s;
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    server {
      listen 443 ssl;
      ssl_certificate /fixtures/cert.pem;
      ssl_certificate_key /fixtures/key.pem;
      location / {
        set $backend http://manager:3000;
        proxy_pass $backend;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 75s;
      }
    }
  }\n`)
  // Pin the public port: Docker reallocates an automatic published port on restart.
  const proxy = await run('proxy', ['--network', network, '-p', `127.0.0.1:${await availablePort()}:443`, ...volume(directory, '/fixtures'), ...volume(nginx, '/etc/nginx/nginx.conf')], 'nginx:1.28-alpine')
  const origin = `https://127.0.0.1:${await port(proxy, '443')}`
  const manager = await run('hosted', [
    '--network', network, '--network-alias', 'manager', ...modules, ...volume(state, '/state', false), ...volume(join(directory, 'cert.pem'), '/test/ca.pem'),
    '-e', 'OUTPOST_MODE=hosted', '-e', 'NODE_ENV=production', '-e', 'HOST=0.0.0.0', '-e', 'PORT=3000', '-e', 'OUTPOST_DATA_DIR=/state',
    '-e', `PUBLIC_APP_URL=${origin}`, '-e', 'NODE_EXTRA_CA_CERTS=/test/ca.pem', '-e', 'ENGAGE_LAB_USERNAME=fixture-user', '-e', 'ENGAGE_LAB_API_KEY=fixture-api-key', '-e', 'ENGAGE_LAB_FROM_EMAIL=Outpost <fixture@example.invalid>',
  ], 'outpost-deployment-test:local')
  const fileInfo = async path => JSON.parse(await docker('exec', manager, 'node', '-e', `
    const fs = require('node:fs'), crypto = require('node:crypto'), path = process.argv[1];
    const bytes = fs.readFileSync(path);
    console.log(JSON.stringify({ length: bytes.length, mode: fs.statSync(path).mode & 0o777, hash: crypto.createHash('sha256').update(bytes).digest('hex') }));
  `, path))
  await t.test('invalid modes, public local listeners and incomplete hosted production configuration fail closed', async () => {
    for (const [name, environment, message] of [
      ['invalid', ['OUTPOST_MODE=typo'], /OUTPOST_MODE must be local or hosted/],
      ['public-local', ['HOST=0.0.0.0'], /loopback/],
      ['missing-mail', ['OUTPOST_MODE=hosted', 'NODE_ENV=production', 'PUBLIC_APP_URL=https://outpost.example.invalid'], /requires ENGAGE_LAB/],
    ]) {
      const failed = await run(name, [...modules, ...environment.flatMap(value => ['-e', value])], 'outpost-deployment-test:local')
      const code = await until(async () => {
        const inspection = JSON.parse(await docker('inspect', failed))[0]
        return inspection.State.Status === 'exited' ? { code: inspection.State.ExitCode } : false
      }, `${name} startup rejection`)
      assert.notEqual(code.code, 0)
      const log = await execute('docker', ['logs', failed])
      assert.match(log.stdout + log.stderr, message)
    }
  })
  const alice = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const bob = await browser.newContext({ ignoreHTTPSErrors: true })
  const phone = await alice.newPage(), other = await bob.newPage()
  const errors = [], launchRequests = [], sockets = []
  phone.on('pageerror', error => errors.push(error.message))
  phone.on('request', request => { if (request.url().endsWith('/launch')) launchRequests.push(request.url()) })
  phone.on('websocket', socket => sockets.push(socket.url()))
  await until(async () => (await alice.request.get(`${origin}/health`)).ok(), 'hosted HTTPS startup')
  const messages = async () => (await fetch(inbox)).json()
  const mailLink = async (email, subject) => until(async () => {
    const message = (await messages()).findLast(item => item.to.includes(email) && item.body.subject === subject)
    return message?.body.content.html.match(/href="([^"]+)"/)?.[1].replaceAll('&amp;', '&')
  }, 'production email delivery')
  async function signup(page, context, email, name) {
    await page.goto(`${origin}/signup`)
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill('fixture account password')
    await page.getByLabel('Confirm password', { exact: true }).fill('fixture account password')
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Account created')
    await expect(page.getByRole('link', { name: 'Open verification link' })).toHaveCount(0)
    const link = await mailLink(email, 'Verify your Outpost email')
    assert.equal(new URL(link).origin, origin)
    await page.goto(link)
    await page.getByRole('button', { name: 'Verify email', exact: true }).click()
    await expect(page.getByText('Hosted service', { exact: true })).toBeVisible()
    const cookie = (await context.cookies()).find(item => item.name === 'outpost_session')
    assert.ok(cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax')
    return (await api(context, 'GET', origin, '/auth/session')).user
  }
  let aliceUser, bobUser, aliceTarget, bobTarget
  await t.test('production signup sends real HTTPS mail to the mock service and verified accounts receive private SSH identities', async () => {
    assert.equal((await alice.request.get(`${origin}/api/targets`)).status(), 401)
    aliceUser = await signup(phone, alice, 'alice@example.invalid', 'Alice phone')
    bobUser = await signup(other, bob, 'bob@example.invalid', 'Bob')
    const publicKeys = []
    for (const [name, context, user] of [['alice', alice, aliceUser], ['bob', bob, bobUser]]) {
      const key = await api(context, 'GET', origin, '/account/ssh-key')
      publicKeys.push(key.publicKey)
      const path = join(directory, `${name}.pub`)
      await writeFile(path, key.publicKey + '\n')
      await docker('cp', path, `${targets[name].container}:/tmp/account.pub`)
      await docker('exec', targets[name].container, 'sh', '-c', 'cat /tmp/account.pub >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys')
      assert.equal((await fileInfo(`/state/users/${user.id}/ssh-key`)).mode, 0o600)
    }
    assert.notEqual(publicKeys[0], publicKeys[1])
    assert.equal((await messages()).length, 2)
  })
  await t.test('hosted users manage only their targets; the server can reach private Docker SSH hosts and rejects desktop/local execution', async () => {
    for (const [name, context] of [['alice', alice], ['bob', bob]]) {
      const target = await api(context, 'POST', origin, '/targets', { kind: 'ssh', name: `${name} private server`, host: `${name}-ssh`, backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'] }, 201)
      const report = await api(context, 'GET', origin, `/targets/${target.id}/software`)
      assert.ok(report.software.every(item => item.status === 'installed'), JSON.stringify(report))
      if (name === 'alice') aliceTarget = target
      else bobTarget = target
    }
    assert.equal((await api(alice, 'GET', origin, '/targets')).length, 1)
    assert.equal((await api(bob, 'GET', origin, '/targets')).length, 1)
    await api(bob, 'GET', origin, `/targets/${aliceTarget.id}/sessions`, undefined, 404)
    await api(bob, 'GET', origin, `/targets/${aliceTarget.id}/terminal-key`, undefined, 404)
    await api(bob, 'PUT', origin, `/targets/${aliceTarget.id}/terminal-key`, { privateKey: 'foreign-user-input' }, 404)
    await api(bob, 'DELETE', origin, `/targets/${aliceTarget.id}/terminal-key`, undefined, 404)
    await api(alice, 'POST', origin, '/targets', { kind: 'local', name: 'Forbidden', tools: ['codex'], backends: ['tmux'] }, 400)
    await api(alice, 'POST', origin, `/targets/${aliceTarget.id}/sessions/${desktopSession.session.id}/launch`, {}, 403)
    assert.ok((await api(alice, 'GET', origin, `/targets/${aliceTarget.id}/sessions`)).sessions.some(session => session.id === desktopSession.session.id), 'hosted mode discovers the local tool’s persistent remote session')
  })
  const sessions = []
  await t.test('all coding tools and persistence backends allocate native conversations over real account SSH', async () => {
    for (const backend of ['tmux', 'dtach']) for (const tool of ['codex', 'claude', 'kimi']) {
      const root = `/root/hosted-${backend}-${tool}`
      const session = await api(alice, 'POST', origin, `/targets/${aliceTarget.id}/sessions`, { backend, tool, name: `${backend} ${tool}`, rootDir: root, createDirectory: true }, 201)
      await docker('exec', targets.alice.container, 'touch', `${root}/capture-input`)
      sessions.push({ session, root })
    }
    const session = await api(bob, 'POST', origin, `/targets/${bobTarget.id}/sessions`, { backend: 'tmux', tool: 'codex', name: 'Bob work', rootDir: '/root/bob-work', createDirectory: true }, 201)
    assert.equal((await api(bob, 'GET', origin, `/targets/${bobTarget.id}/sessions`)).sessions.length, 1)
    await api(alice, 'GET', origin, `/targets/${bobTarget.id}/sessions/${session.id}`, undefined, 404)
  })
  const openTerminal = async session => {
    await phone.getByRole('button', { name: `Connection options for ${session.name}`, exact: true }).click()
    await phone.getByRole('menuitem', { name: 'Launch with web terminal', exact: true }).click()
  }
  const first = sessions[0]
  const heartbeat = async item => JSON.parse(await docker('exec', targets.alice.container, 'cat', `${item.root}/heartbeat.json`))
  let originalPid, encryptionKey
  await t.test('phone opt-in, encrypted private-key upload, real SSH PTY input, touch controls and resizing through nginx', async () => {
    await phone.goto(`${origin}/?target=${aliceTarget.id}`)
    await expect(phone.getByText(first.session.name, { exact: true })).toBeVisible()
    await expect(phone.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
    const webRequests = []
    phone.on('request', request => { if (/\/api\/.*(?:web-terminal|terminal-key)/.test(request.url())) webRequests.push(request.url()) })
    await phone.getByRole('button', { name: 'Connection options', exact: true }).first().click()
    await expect(phone.getByRole('dialog')).toBeVisible()
    await expect(phone.getByRole('button', { name: 'Launch terminal', exact: true })).toHaveCount(0)
    assert.deepEqual(webRequests, [])
    await phone.getByRole('button', { name: 'Done', exact: true }).click()
    await openTerminal(first.session)
    await expect(phone.getByText('Add your SSH private key', { exact: true })).toBeVisible()
    await phone.getByLabel('Private key file', { exact: true }).setInputFiles(webKey)
    await phone.getByLabel('Key passphrase', { exact: true }).fill('wrong-passphrase')
    await phone.getByRole('button', { name: 'Save key and launch', exact: true }).click()
    await expect(phone.getByRole('alert')).toBeVisible()
    assert.equal((await api(alice, 'GET', origin, `/targets/${aliceTarget.id}/terminal-key`)).key, null)
    await phone.getByLabel('Key passphrase', { exact: true }).fill('fixture-passphrase')
    await phone.getByRole('button', { name: 'Save key and launch', exact: true }).click()
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    originalPid = (await until(() => heartbeat(first), 'web coding process')).pid
    await phone.getByLabel('Terminal text', { exact: true }).fill('PHONE_CONTAINER_INPUT')
    await phone.getByRole('button', { name: 'Send', exact: true }).click()
    await phone.getByRole('button', { name: 'Ctrl+C', exact: true }).click()
    await until(async () => {
      const input = await docker('exec', targets.alice.container, 'cat', `${first.root}/input.bin`)
      return input.includes('PHONE_CONTAINER_INPUT') && input.includes('\x03')
    }, 'phone input on remote target')
    const input = (await execute('docker', ['exec', targets.alice.container, 'cat', `${first.root}/input.bin`], { encoding: 'buffer' })).stdout
    assert.ok(input.includes(Buffer.from([3])), 'the touch Ctrl+C control reaches the SSH PTY')
    await phone.setViewportSize({ width: 844, height: 390 })
    await until(async () => (await docker('exec', targets.alice.container, 'cat', `${first.root}/sizes.log`)).split('\n').some(size => Number(size.split('x')[0]) > 60), 'landscape resize')
    await phone.setViewportSize({ width: 390, height: 844 })
    assert.ok(await phone.getByRole('dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth))
    await phone.screenshot({ path: join(project, 'test-results/deployment-hosted-phone.png') })
    encryptionKey = await fileInfo('/state/terminal-keys/master-key')
    assert.equal(encryptionKey.length, 32); assert.equal(encryptionKey.mode, 0o600)
    const encrypted = await docker('exec', manager, 'node', '-e', `
      const fs = require('node:fs'), root = '/state/terminal-keys';
      const files = fs.readdirSync(root).filter(name => name.endsWith('.json'));
      console.log(files.length > 0 && files.every(name => {
        const text = fs.readFileSync(root+'/'+name, 'utf8');
        return !text.includes('PRIVATE KEY') && !text.includes('fixture-passphrase');
      }));
    `)
    assert.equal(encrypted, 'true')
    await api(bob, 'GET', origin, `/targets/${bobTarget.id}/terminal-key`).then(info => assert.equal(info.key, null))
  })
  await t.test('proxy/network disconnect restores the same held web PTY and coding process', async () => {
    const previous = sockets.length, original = sockets.at(-1)
    await docker('restart', proxy)
    await until(async () => (await alice.request.get(`${origin}/health`)).ok(), 'proxy restart')
    await expect.poll(() => sockets.length).toBeGreaterThan(previous)
    assert.equal(sockets.at(-1), original, 'network reconnect uses the same terminal ID over WSS')
    assert.ok(original.startsWith('wss:'))
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    assert.equal((await heartbeat(first)).pid, originalPid)
    assert.equal((await docker('exec', targets.alice.container, 'cat', `${first.root}/starts.log`)).trim(), String(originalPid))
  })
  await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await t.test('a backend restart keeps accounts, targets, encrypted uploads and the coding process; relaunch uses the saved key', async () => {
    await docker('restart', manager)
    await until(async () => (await alice.request.get(`${origin}/health`)).ok(), 'backend restart')
    assert.equal((await api(alice, 'GET', origin, '/auth/session')).user.id, aliceUser.id)
    assert.equal((await api(alice, 'GET', origin, '/targets'))[0].id, aliceTarget.id)
    assert.equal((await fileInfo('/state/terminal-keys/master-key')).hash, encryptionKey.hash)
    await phone.reload()
    await openTerminal(first.session)
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    await expect(phone.getByLabel('Private key file', { exact: true })).toHaveCount(0)
    assert.equal((await heartbeat(first)).pid, originalPid)
    await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
  })
  await t.test('all six tool/backend combinations run, detach and reattach through real mobile web terminals', async () => {
    for (const item of sessions) {
      await openTerminal(item.session)
      await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
      const initial = await until(() => heartbeat(item), item.session.name)
      assert.equal(initial.tool, item.session.tool); assert.equal(initial.cliSessionId, item.session.cliSessionId)
      await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await openTerminal(item.session)
      await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
      assert.equal((await heartbeat(item)).pid, initial.pid)
      await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
    }
  })
  await t.test('removing an uploaded key closes its attachment; replacing it resumes the same remote process', async () => {
    await openTerminal(first.session)
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    await phone.getByRole('button', { name: 'Manage key', exact: true }).click()
    await phone.getByRole('button', { name: 'Remove saved key', exact: true }).click()
    await expect(phone.getByText('Add your SSH private key', { exact: true })).toBeVisible()
    assert.equal((await api(alice, 'GET', origin, `/targets/${aliceTarget.id}/terminal-key`)).key, null)
    assert.equal((await heartbeat(first)).pid, originalPid)
    await phone.getByLabel('Private key file', { exact: true }).setInputFiles(webKey)
    await phone.getByLabel('Key passphrase', { exact: true }).fill('fixture-passphrase')
    await phone.getByRole('button', { name: 'Save key and launch', exact: true }).click()
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    assert.equal((await heartbeat(first)).pid, originalPid)
    await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
  })
  await t.test('termination closes the web attachment and stops the process; reconnect resumes the same conversation', async () => {
    const item = sessions.at(-1), base = `/targets/${aliceTarget.id}/sessions/${item.session.id}`
    const initial = await heartbeat(item)
    await openTerminal(item.session)
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    const terminated = await api(alice, 'POST', origin, `${base}/terminate`)
    assert.equal(terminated.status, 'stopped'); assert.equal(terminated.cliSessionId, item.session.cliSessionId)
    await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await openTerminal(item.session)
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    const resumed = await until(async () => { const current = await heartbeat(item); return current.pid !== initial.pid && current }, 'coding process restart')
    assert.equal(resumed.cliSessionId, item.session.cliSessionId)
    await phone.getByRole('button', { name: 'Close dialog', exact: true }).click()
  })
  await t.test('password reset through production mock email revokes login and closes its live terminal without terminating the coding session', async () => {
    await openTerminal(first.session)
    await expect(phone.locator('.terminal-toolbar')).toContainText('Connected')
    const resetContext = await browser.newContext({ ignoreHTTPSErrors: true }), reset = await resetContext.newPage()
    await reset.goto(`${origin}/forgot-password`)
    await reset.getByRole('textbox', { name: 'Email', exact: true }).fill('alice@example.invalid')
    await reset.getByRole('button', { name: /Send reset link/i }).click()
    const link = await mailLink('alice@example.invalid', 'Reset your Outpost password')
    await reset.goto(link)
    await reset.getByLabel('Password', { exact: true }).fill('fixture reset password')
    await reset.getByLabel('Confirm password', { exact: true }).fill('fixture reset password')
    await reset.getByRole('button', { name: /Reset password/i }).click()
    await expect(reset.getByRole('status')).toContainText('Password reset')
    await api(alice, 'GET', origin, '/targets', undefined, 401)
    await until(async () => (await docker('exec', targets.alice.container, 'tmux', '-S', first.session.socketPath, 'display-message', '-p', '#{session_attached}')) === '0', 'login revocation detaches remote terminal')
    assert.equal((await heartbeat(first)).pid, originalPid)
    await resetContext.close()
  })
  assert.deepEqual(launchRequests, [], 'hosted browser never requests a desktop launch')
  assert.deepEqual(errors, [], 'browser has no uncaught errors')
  const logs = await docker('logs', manager)
  assert.ok(!logs.includes('fixture-passphrase') && !logs.includes('PRIVATE KEY'))
})
