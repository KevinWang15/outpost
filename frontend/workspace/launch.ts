import { Value } from 'typebox/value'
import type { LaunchSettings, SessionSettings } from '../../shared/model'
import { sessionSettings } from '../../shared/schemas'

/** A form's copy of launch settings: text as typed, environment as rows. */
export interface LaunchDraft {
  instructions: string
  model: string
  mode: string
  /** The mcpServers JSON object, or empty for none. */
  servers: string
  args: string
  env: EnvRow[]
}
interface EnvRow {
  id: number
  name: string
  value: string
}

let nextRow = 0
export const envRow = (name = '', value = ''): EnvRow => ({ id: nextRow++, name, value })

export const launchDraft = (settings?: LaunchSettings): LaunchDraft => ({
  instructions: settings?.instructions ?? '',
  model: settings?.model ?? '',
  mode: settings?.mode ?? '',
  servers: settings && Object.keys(settings.mcpServers).length ? JSON.stringify(settings.mcpServers, null, 2) : '',
  args: settings?.args ?? '',
  env: Object.entries(settings?.env ?? {}).map(([name, value]) => envRow(name, value)),
})

/** The settings a draft holds. Throws when the form cannot express them. */
export function readDraft(draft: LaunchDraft): LaunchSettings {
  const names = draft.env.map(row => row.name)
  if (new Set(names).size !== names.length) throw new Error('Environment variable names must be unique.')
  let mcpServers: LaunchSettings['mcpServers'] = {}
  if (draft.servers.trim())
    try {
      mcpServers = JSON.parse(draft.servers)
    } catch (error) {
      throw new Error(`MCP servers are not valid JSON: ${(error as Error).message}`, { cause: error })
    }
  return {
    instructions: draft.instructions.trim() || null,
    model: draft.model.trim() || null,
    mode: draft.mode.trim() || null,
    mcpServers,
    args: draft.args,
    env: Object.fromEntries(draft.env.map(row => [row.name, row.value])),
  }
}

const hints: Record<string, string> = {
  name: 'name is 1 to 80 characters, not only spaces',
  delivery: 'delivery is "auto" or "manual"',
  instructions: 'instructions is text up to 32,000 characters, or null',
  model: 'model is the coding tool’s name for a model, or null',
  mode: 'mode is the coding tool’s name for a mode, or null',
  args: 'args is one string of Bash arguments',
  env: 'env maps variable names (letters, digits and _) to string values',
  mcpServers: 'mcpServers maps names (letters, digits, _ and -; not “outpost”, Outpost’s own) to servers, at most 16',
}

/** What is wrong with session settings, in words, or null when they are valid. */
export function settingsProblem(value: unknown): string | null {
  if (Value.Check(sessionSettings, value)) return null
  // Unions report every branch they tried; skip those summaries.
  const errors = Value.Errors(sessionSettings, value).filter(item => !['anyOf', 'boolean'].includes(item.keyword))
  const error = errors[0]
  if (!error) return 'These settings are not valid.'
  const [field, server] = error.instancePath.split('/').slice(1)
  if (!field) {
    const params = error.params as { additionalProperties?: string[]; requiredProperties?: string[] }
    if (params.additionalProperties)
      return `Unknown setting ${params.additionalProperties.join(', ')}. The settings are ${Object.keys(hints).join(', ')}.`
    if (params.requiredProperties) return `Missing setting ${params.requiredProperties.join(', ')}.`
    return 'The settings must be one JSON object.'
  }
  if (field === 'mcpServers' && server) {
    const detail = errors.find(
      item => item.instancePath.startsWith(`/mcpServers/${server}/`) && !['const', 'required'].includes(item.keyword),
    )
    return (
      `MCP server ${server} needs a "command" (with optional "args" and "env"), or "type": "http" with a "url" and optional "headers".` +
      (detail
        ? ` Its ${detail.instancePath.split('/').slice(3).join('.')} ${detail.keyword === 'pattern' ? 'is not valid' : detail.message}.`
        : '')
    )
  }
  return `Invalid ${field}: ${hints[field] ?? error.message}.`
}

/** Settings from Edit source, checked. */
export function parseSource(text: string): SessionSettings {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`This is not valid JSON: ${(error as Error).message}`, { cause: error })
  }
  const problem = settingsProblem(value)
  if (problem) throw new Error(problem)
  return value as SessionSettings
}
