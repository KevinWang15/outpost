import ssh2, { type Connection, type ServerChannel } from 'ssh2'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'

// A real SSH handshake and channel, with a deterministic terminal process.
export async function webSshFixture() {
  const key = ssh2.utils.generateKeyPairSync('ed25519')
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
  const allowed: ssh2.ParsedKey[] = []
  const authorize = (publicKey: string) => {
    const parsed = ssh2.utils.parseKey(publicKey)
    if (parsed instanceof Error) throw parsed
    allowed.push(parsed)
  }
  authorize(key.public)
  const clients = new Set<Connection>(), channels = new Set<ServerChannel>()
  const inputs: string[] = [], sizes: number[][] = [], commands: string[] = []
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => {
      if (ctx.username === 'root' && ctx.method === 'publickey' && allowed.some(key => ctx.key.data.equals(key.getPublicSSH()) && (!ctx.signature || (ctx.blob && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo))))) ctx.accept()
      else ctx.reject()
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', (accept, _reject, info) => { sizes.push([info.cols, info.rows]); accept() })
      session.on('window-change', (accept, _reject, info) => { sizes.push([info.cols, info.rows]); accept?.() })
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command)
        const channel = accept(); channels.add(channel)
        channel.on('error', () => {})
        channel.on('close', () => channels.delete(channel))
        channel.on('data', (bytes: Buffer) => { inputs.push(bytes.toString()); channel.write(bytes) })
        channel.write('\x1b[32mSSH fixture ready\x1b[0m\r\n')
      })
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return {
    key: key.private, publicKey: key.public, hostKey: hostKey.private, hostPublicKey: hostKey.public, port: (server.address() as AddressInfo).port, inputs, sizes, commands, authorize,
    output: (text: string, stderr = false) => { for (const channel of channels) (stderr ? channel.stderr : channel).write(text) },
    close: async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
