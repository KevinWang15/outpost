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
  /** The Linux user sessions run as; root is allowed, never assumed. */
  user: Type.String({ minLength: 1, maxLength: 32, pattern: '^[A-Za-z_][A-Za-z0-9._-]*$' }),
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
const rootDir = Type.String({ minLength: 1, maxLength: 4096, pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]*$' })
const args = Type.String({ maxLength: 8192, pattern: '^[^\\u0000]*$' })
const env = Type.Record(Type.String(), Type.String({ maxLength: 4096, pattern: '^[^\\u0000]*$' }), {
  maxProperties: 32,
  propertyNames: { maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])' },
})
const instructions = Type.Union([Type.String({ maxLength: 32_000 }), Type.Null()])
/** The tool's own name for a model or mode, e.g. "opus" or "plan". */
const choice = Type.Union([text(200), Type.Null()])
const headers = Type.Record(Type.String(), Type.String({ maxLength: 4096, pattern: '^[^\\u0000\\r\\n]*$' }), {
  maxProperties: 16,
  propertyNames: { maxLength: 100, pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?![\\s\\S])" },
})
/** An MCP server the coding tool connects to, in the common mcpServers format.
 * "outpost" is Outpost's own server. */
const mcpServer = Type.Union([
  Type.Object(
    {
      type: Type.Optional(Type.Literal('stdio')),
      command: text(4096),
      args: Type.Optional(Type.Array(Type.String({ maxLength: 4096, pattern: '^[^\\u0000]*$' }), { maxItems: 64 })),
      env: Type.Optional(env),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal('http'),
      url: Type.String({ maxLength: 2048, pattern: '^https?://[^\\s]+$' }),
      headers: Type.Optional(headers),
    },
    strict,
  ),
])
const mcpServers = Type.Record(Type.String(), mcpServer, {
  maxProperties: 16,
  propertyNames: { pattern: '^(?!outpost(?![\\s\\S]))[A-Za-z0-9_-]{1,64}(?![\\s\\S])' },
})
/** What a session's coding tool starts with. */
const launch = { instructions, model: choice, mode: choice, mcpServers, args, env }
/** Native store location, e.g. { CLAUDE_CONFIG_DIR: '/home/me/.claude' }. */
const storage = Type.Record(Type.String(), absolutePath, { minProperties: 1, maxProperties: 1 })
// Each harness pins its own native conversation ID format and storage variable.
const perHarness = (conversation: boolean) =>
  harnesses.map(harness => ({
    if: { properties: { tool: { const: harness.id } } },
    then: {
      properties: {
        ...(conversation ? { conversation: { type: 'string', pattern: harness.nativeId } } : {}),
        storage: { type: 'object', propertyNames: { const: harness.storageKey } },
      },
    },
  }))

/** A new session; `conversation` links an existing native conversation instead of starting one. */
export const sessionInput = Type.Object(
  {
    name,
    rootDir,
    createDirectory: Type.Optional(Type.Boolean()),
    tool: harnessId,
    ...Type.Partial(Type.Object(launch)).properties,
    conversation: Type.Optional(Type.String({ maxLength: 128 })),
    storage: Type.Optional(storage),
  },
  { ...strict, dependencies: { storage: ['conversation'] }, allOf: perHarness(true) },
)

/** What a session runs with. Each change is a new revision; a running driver
 * keeps the revision it started with until the session restarts. */
export const sessionConfig = Type.Object({ revision: Type.Integer({ minimum: 1 }), ...launch }, strict)

/** How messages from other sessions, channels and schedules reach a terminal:
 * typed in when the agent is idle, or held until you deliver them. */
const delivery = Type.Union([Type.Literal('auto'), Type.Literal('manual')])

/** Everything about a session you can edit, as Edit source shows it. */
export const sessionSettings = Type.Object({ name, delivery, ...launch }, strict)

/** An edit names the revision it was based on; a concurrent edit is refused. */
export const sessionUpdate = Type.Object(
  { revision: Type.Integer({ minimum: 1 }), ...Type.Partial(sessionSettings).properties },
  { ...strict, minProperties: 2 },
)

/** One native conversation in a session's timeline. `movedTo` names the
 * session that resumed it since; it then belongs there. */
export const sessionConversation = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    startedAt: text(80),
    movedTo: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
)

/** A session as its machine stores it. The last conversation is the current one. */
export const sessionRecord = Type.Object(
  {
    id: Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }),
    name,
    tool: harnessId,
    rootDir: absolutePath,
    createdAt: text(80),
    lastConnectedAt: Type.Union([text(80), Type.Null()]),
    storage,
    delivery,
    config: sessionConfig,
    conversations: Type.Array(sessionConversation, { minItems: 1, maxItems: 200 }),
  },
  { ...strict, allOf: perHarness(false) },
)

export const sessionForkInput = Type.Object({ branch: text(256), rootDir }, strict)

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
export const softwareIds = ['bash', 'outpost-terminal', ...harnessIds, 'claude-agent-acp'] as const
export const installationInput = Type.Object(
  {
    softwareId: Type.Enum(softwareIds),
    script: Type.String({ minLength: 1, maxLength: 64 * 1024, pattern: '^[^\\u0000]+$' }),
  },
  strict,
)
