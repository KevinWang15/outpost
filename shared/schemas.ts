// Request and stored-record schemas. Validation uses these directly, and the
// matching types in shared/model.ts are derived from them, so the two cannot
// drift. Strings exclude control characters unless they carry free text.
import Type from 'typebox'
import { harnesses, harnessIds } from './harnesses'

const strict = { additionalProperties: false } as const
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const absolutePath = Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000-\\u001f\\u007f]*$' })

export const name = Type.String({ minLength: 1, maxLength: 80, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' })
export const harnessId = Type.Enum(harnessIds)
const tools = Type.Array(harnessId, { minItems: 1, maxItems: harnessIds.length, uniqueItems: true })

// Targets ---------------------------------------------------------------------
const ssh = {
  kind: Type.Literal('ssh'),
  name,
  tools,
  host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  identityFile: Type.Optional(
    Type.String({ minLength: 1, maxLength: 1024, pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]+$' }),
  ),
}
const local = { kind: Type.Literal('local'), name, tools }
export const environment = Type.Object(
  { home: absolutePath, username: text(256), uid: Type.Integer({ minimum: 0 }), shell: absolutePath },
  strict,
)
const metadata = { id: text(80), createdAt: text(80), environment: Type.Optional(environment) }

export const targetInput = Type.Union([Type.Object(ssh, strict), Type.Object(local, strict)])
export const targetRecord = Type.Union([
  Type.Object({ ...ssh, ...metadata }, strict),
  Type.Object({ ...local, ...metadata }, strict),
])
export const targetUpdate = Type.Object(
  { name: Type.Optional(name), tools: Type.Optional(tools) },
  { ...strict, minProperties: 1 },
)

// Sessions --------------------------------------------------------------------
const session = {
  name,
  rootDir: Type.String({ minLength: 1, maxLength: 4096, pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]*$' }),
  createDirectory: Type.Optional(Type.Boolean()),
  args: Type.Optional(Type.String({ maxLength: 8192, pattern: '^[^\\u0000]*$' })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String({ maxLength: 4096, pattern: '^[^\\u0000]*$' }), {
      maxProperties: 32,
      propertyNames: { maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])' },
    }),
  ),
}
// Each harness pins its own native conversation ID format and storage variable.
export const sessionInput = Type.Object(
  {
    ...session,
    tool: harnessId,
    cliSessionId: Type.Optional(Type.String({ maxLength: 128 })),
    cliSessionEnv: Type.Optional(Type.Record(Type.String(), absolutePath, { minProperties: 1, maxProperties: 1 })),
  },
  {
    ...strict,
    dependencies: { cliSessionEnv: ['cliSessionId'] },
    allOf: harnesses.map(harness => ({
      if: { properties: { tool: { const: harness.id } } },
      then: {
        properties: {
          cliSessionId: { type: 'string', pattern: harness.nativeId },
          cliSessionEnv: { type: 'object', propertyNames: { const: harness.storageKey } },
        },
      },
    })),
  },
)

export const sessionForkInput = Type.Object({ branch: text(256), rootDir: session.rootDir }, strict)

export const desktopSessionCreationInput = Type.Object(
  {
    requestId: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
    input: sessionInput,
  },
  strict,
)

export const acknowledgeInput = Type.Object({ completionId: Type.String({ pattern: '^[0-9a-f]{64}$' }) }, strict)
export const conversationSearch = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 256, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' }),
    tool: Type.Optional(harnessId),
  },
  strict,
)
export const directoryQuery = Type.Object(
  { path: Type.String({ maxLength: 4096, pattern: '^(|~|(?:~/|/)[^\\u0000-\\u001f\\u007f]*)$' }) },
  strict,
)

// Software ----------------------------------------------------------------------
export const softwareIds = ['bash', 'python3', 'outpost-terminal', ...harnessIds] as const
export const installationInput = Type.Object(
  {
    softwareId: Type.Enum(softwareIds),
    script: Type.String({ minLength: 1, maxLength: 64 * 1024, pattern: '^[^\\u0000]+$' }),
  },
  strict,
)
