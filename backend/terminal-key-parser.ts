import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { AppError } from './errors'

// Encrypted OpenSSH keys can request expensive bcrypt work. Parse outside the
// API thread, with a deadline, then normalize so launches never repeat that work.
const source = `
const { parentPort, workerData } = require('node:worker_threads');
const { createPrivateKey, randomBytes } = require('node:crypto');
const { utils } = require(workerData.modulePath);
const uint = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const string = value => { const b = Buffer.from(value); return Buffer.concat([uint(b.length), b]); };
try {
  const result = utils.parseKey(workerData.privateKey, workerData.passphrase);
  const key = Array.isArray(result) ? result[0] : result;
  if (key instanceof Error || !key?.isPrivateKey()) throw new Error('invalid');
  const native = createPrivateKey(key.getPrivatePEM());
  let normalized;
  if (key.type === 'ssh-ed25519') {
    const jwk = native.export({ format: 'jwk' });
    const publicKey = Buffer.from(jwk.x, 'base64url');
    const privateKey = Buffer.concat([Buffer.from(jwk.d, 'base64url'), publicKey]);
    const check = randomBytes(4);
    let block = Buffer.concat([check, check, string('ssh-ed25519'), string(publicKey), string(privateKey), string('')]);
    const padding = 8 - block.length % 8;
    block = Buffer.concat([block, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
    const encoded = Buffer.concat([Buffer.from('openssh-key-v1\\0'), string('none'), string('none'), string(''), uint(1), string(key.getPublicSSH()), string(block)]).toString('base64');
    normalized = '-----BEGIN OPENSSH PRIVATE KEY-----\\n' + encoded.match(/.{1,70}/g).join('\\n') + '\\n-----END OPENSSH PRIVATE KEY-----\\n';
  } else if (key.type === 'ssh-rsa' || key.type.startsWith('ecdsa-')) {
    normalized = native.export({ format: 'pem', type: key.type === 'ssh-rsa' ? 'pkcs1' : 'sec1' });
  } else throw new Error('unsupported');
  const verified = utils.parseKey(normalized);
  if (verified instanceof Error || !verified.getPublicSSH().equals(key.getPublicSSH())) throw new Error('invalid');
  parentPort.postMessage({ privateKey: normalized, publicKey: key.getPublicSSH().toString('base64'), type: key.type });
} catch { parentPort.postMessage(null); }
`
export async function parseTerminalKey(privateKey: string, passphrase: string): Promise<{ privateKey: string; publicKey: string; type: string }> {
  const worker = new Worker(source, { eval: true, workerData: { privateKey, passphrase, modulePath: createRequire(import.meta.url).resolve('ssh2') }, resourceLimits: { maxOldGenerationSizeMb: 32 } })
  let deadline: NodeJS.Timeout | undefined
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new AppError('Upload a valid Ed25519, RSA, or ECDSA SSH private key with the correct passphrase. Keys must decrypt within 4 seconds.', 400))
      deadline = setTimeout(fail, 4000).unref()
      worker.once('message', result => result ? resolve(result) : fail())
      worker.once('error', fail); worker.once('exit', fail)
    })
  } finally { clearTimeout(deadline); await worker.terminate() }
}
