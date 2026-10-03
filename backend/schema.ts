import { Ajv } from 'ajv'
import type { Target } from '../shared/session-manager'
import { imageMediaTypes } from '../shared/session-manager'

const textField = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
export const targetBody = {
  oneOf: [
    { properties: { kind: { const: 'ssh' } }, required: ['host'], not: { required: ['distribution'] } },
    { properties: { kind: { const: 'local' } }, not: { anyOf: [{ required: ['host'] }, { required: ['port'] }, { required: ['identityFile'] }] } },
  ],
  type: 'object', additionalProperties: false, required: ['name', 'kind', 'backends', 'tools'],
  properties: {
    name: { ...textField(80), pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' },
    kind: { type: 'string', enum: ['ssh', 'local'] },
    distribution: textField(128),
    host: { type: 'string', maxLength: 253, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    identityFile: { ...textField(1024), pattern: '^(~[/\\\\]|/|[a-zA-Z]:[/\\\\]|\\\\\\\\)[^\\u0000-\\u001f\\u007f]+$' },
    backends: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['tmux', 'dtach'] } },
    tools: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['codex', 'kimi', 'claude'] } },
  },
}
export const requirementsBody = {
  type: 'object', additionalProperties: false, required: ['backends', 'tools'],
  properties: { backends: targetBody.properties.backends, tools: targetBody.properties.tools },
}
export const imageBody = {
  type: 'object', additionalProperties: false, required: ['data', 'mediaType'],
  properties: {
    data: { type: 'string', minLength: 8, maxLength: 24 * 1024 * 1024, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
    mediaType: { enum: imageMediaTypes },
  },
}
const uuidPattern = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
const codingIdentity = (tool: string, storageKey: string, pattern: string) => ({
  properties: {
    tool: { const: tool },
    cliSessionId: { type: 'string', pattern },
    cliSessionEnv: { type: 'object', propertyNames: { const: storageKey } },
  },
})
export const sessionBody = {
  oneOf: [
    codingIdentity('codex', 'CODEX_HOME', uuidPattern),
    codingIdentity('claude', 'CLAUDE_CONFIG_DIR', uuidPattern),
    codingIdentity('kimi', 'KIMI_CODE_HOME', '^session_[A-Za-z0-9_-]{1,120}$'),
  ],
  dependencies: { cliSessionEnv: ['cliSessionId'] },
  type: 'object', additionalProperties: false, required: ['name', 'rootDir', 'backend', 'tool'],
  properties: {
    name: { ...textField(80), pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' },
    rootDir: { ...textField(4096), pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]*$' },
    createDirectory: { type: 'boolean' },
    backend: { type: 'string', enum: ['tmux', 'dtach'] },
    tool: { type: 'string', enum: ['codex', 'kimi', 'claude'] },
    cliSessionId: { type: 'string', maxLength: 128 },
    cliSessionEnv: {
      type: 'object', minProperties: 1, maxProperties: 1,
      additionalProperties: { ...textField(4096), pattern: '^/[^\\u0000-\\u001f\\u007f]*$' },
    },
    args: { type: 'string', maxLength: 8192, pattern: '^[^\\u0000]*$' },
    env: {
      type: 'object', maxProperties: 32,
      propertyNames: { maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])' },
      additionalProperties: { type: 'string', maxLength: 4096, pattern: '^[^\\u0000]*$' },
    },
  },
}

export const codingSessionSearchBody = {
  type: 'object', additionalProperties: false, required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 256, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' },
    tool: { enum: ['codex', 'kimi', 'claude'] },
  },
}

const environmentSchema = {
  type: 'object', additionalProperties: false,
  required: ['home', 'platform', 'username', 'uid', 'shell'],
  properties: {
    home: { ...textField(4096), pattern: '^/[^\\u0000-\\u001f\\u007f]*$' },
    platform: { enum: ['linux', 'darwin'] },
    username: textField(256), uid: { type: 'integer', minimum: 0 }, shell: { ...textField(4096), pattern: '^/[^\\u0000-\\u001f\\u007f]*$' },
  },
}
const targetSchema = {
  ...targetBody,
  required: [...targetBody.required, 'id', 'createdAt'],
  properties: { ...targetBody.properties, id: textField(80), createdAt: textField(80), environment: environmentSchema },
}
export interface TargetConfig { secret: string; targets: Target[] }
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
export const validTarget = ajv.compile<Target>(targetSchema)
export const validConfig = ajv.compile<TargetConfig>({
  type: 'object', additionalProperties: false, required: ['secret', 'targets'],
  properties: { secret: { type: 'string', pattern: '^[a-f0-9]{64}$' }, targets: { type: 'array', items: targetSchema } },
})
