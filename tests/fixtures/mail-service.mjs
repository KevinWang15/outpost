import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

// Disposable EngageLab-compatible service. The application uses its actual
// production mailer, DNS, HTTPS verification, and request format against this.
const messages = []
const authorization = `Basic ${Buffer.from('fixture-user:fixture-api-key').toString('base64')}`
httpsServer({ key: readFileSync('/fixtures/key.pem'), cert: readFileSync('/fixtures/cert.pem') }, async (request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.method !== 'POST' || request.url !== '/v1/mail/send' || request.headers.authorization !== authorization) {
    response.writeHead(403); response.end('{}'); return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  try {
    const message = JSON.parse(body)
    if (!Array.isArray(message.to) || !message.body?.subject || !message.body?.content?.html) throw new Error('Invalid mail')
    messages.push(message)
    response.end('{"accepted":true}')
  } catch {
    response.writeHead(400); response.end('{}')
  }
}).listen(443, '0.0.0.0')
httpServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.url === '/messages') response.end(JSON.stringify(messages))
  else { response.writeHead(404); response.end('{}') }
}).listen(80, '0.0.0.0')
