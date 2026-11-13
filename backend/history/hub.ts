import { Ajv } from 'ajv'
import { join } from 'node:path'
import definitions from '../../shared/historyTools.json' with { type: 'json' }
import type { HistoryBatch, HistoryMachine, HistorySearchInput, HistorySource } from '../../shared/history'
import type { Deployment, Owner } from '../deployment'
import type { TargetContext } from '../sessions'
import { machineHistory, type HistoryReader } from './client'
import { localEmbeddings, type Embed } from './embeddings'
import { HistoryIndex } from './index'

interface MachineState {
  after: string | null
  pending: Map<string, HistorySource>
  refreshing: Promise<void> | null
  checkedAt: string | null
  error: string | null
  warnings: string[]
}
interface Account {
  owner: Owner
  index: HistoryIndex
  states: Map<string, MachineState>
  syncing: Promise<void> | null
  machines: HistoryMachine[]
  embeddingError: string | null
  embeddingRetryAt: number
  continuation: NodeJS.Timeout | null
  embeddingJob: Promise<void> | null
  closed: boolean
}
export interface HistoryOptions {
  reader?: HistoryReader
  embed?: Embed
  /** Tests can drive refreshes explicitly, without background refreshes. */
  background?: boolean
}
interface Dependencies extends HistoryOptions {
  deployment: Deployment
  resolve(owner: Owner, id: string): Promise<TargetContext>
}
const validate = new Map(
  definitions.map(tool => [tool.name, new Ajv({ strict: false, allErrors: true }).compile(tool.inputSchema)]),
)

/** Account-private index of all native conversations on configured targets. */
export class HistoryHub {
  private accounts = new Map<string, Account>()
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private reader: HistoryReader
  private embed: Embed
  constructor(private dependencies: Dependencies) {
    this.reader = dependencies.reader ?? machineHistory
    this.embed = dependencies.embed ?? localEmbeddings(dependencies.deployment.directory)
  }
  private account(owner: Owner) {
    let account = this.accounts.get(owner.userId)
    if (!account) {
      const directory = this.dependencies.deployment.workspace(owner).directory
      account = {
        owner,
        index: new HistoryIndex(
          join(directory, 'history', 'index.sqlite'),
          `${this.dependencies.deployment.secret}:${owner.userId}`,
          this.embed,
        ),
        states: new Map(),
        syncing: null,
        machines: [],
        embeddingError: null,
        embeddingRetryAt: 0,
        continuation: null,
        embeddingJob: null,
        closed: false,
      }
      this.accounts.set(owner.userId, account)
    }
    return account
  }
  async start() {
    if (this.dependencies.background === false) return
    for (const owner of this.dependencies.deployment.historyOwners()) this.watch(owner)
    this.timer = setInterval(() => {
      for (const owner of this.dependencies.deployment.historyOwners())
        if (!this.accounts.has(owner.userId)) this.watch(owner)
      for (const [id, account] of this.accounts) {
        if (!this.dependencies.deployment.account(id)) {
          account.closed = true
          if (account.continuation) clearTimeout(account.continuation)
          // An in-flight refresh is drained before its private index closes.
          void Promise.resolve(account.syncing).finally(() => account.index.close())
          this.accounts.delete(id)
        } else void this.sync(account)
      }
    }, 10000).unref()
  }
  watch(owner: Owner) {
    if (this.stopped || this.dependencies.background === false) return
    const account = this.account(owner)
    account.owner = owner
    void this.sync(account)
  }
  private async machines(account: Account) {
    const targets = await this.dependencies.deployment.workspace(account.owner).list()
    account.machines = targets.map(target => ({
      id: target.id,
      name: target.name,
      host: target.kind === 'ssh' ? target.host : 'localhost',
    }))
    for (const id of account.states.keys()) if (!targets.some(target => target.id === id)) account.states.delete(id)
    return account.machines
  }
  private state(account: Account, id: string) {
    let state = account.states.get(id)
    if (!state) {
      state = {
        after: null,
        pending: new Map(),
        refreshing: null,
        checkedAt: null,
        error: null,
        warnings: [],
      }
      account.states.set(id, state)
    }
    return state
  }
  private refreshMachine(account: Account, machine: HistoryMachine) {
    const state = this.state(account, machine.id)
    state.refreshing ??= (async () => {
      try {
        const context = await this.dependencies.resolve(account.owner, machine.id)
        const signal = AbortSignal.timeout(20000)
        const catalog = await this.reader.catalog(context, state.after, signal)
        if (this.stopped || account.closed) return
        state.after = catalog.next
        state.warnings = catalog.warnings
        for (const source of catalog.sources) {
          const checkpoint = account.index.checkpoint(machine.id, source)
          if (
            !checkpoint ||
            checkpoint.modified !== source.modified ||
            checkpoint.offset < checkpoint.size ||
            (checkpoint.sourceSize ?? checkpoint.size) !== source.size
          )
            state.pending.set(source.id, source)
          else
            account.index.ingest(machine, {
              files: [{ source, checkpoint, reset: false, messages: [], pending: false }],
              warnings: [],
            })
        }
        if (state.pending.size) {
          const sources = [...state.pending.values()]
            .sort((a, b) => Number(BigInt(b.modified) - BigInt(a.modified)))
            .slice(0, 100)
            .map(source => ({ source, checkpoint: account.index.checkpoint(machine.id, source) }))
          const batch = await this.reader.read(context, sources, signal)
          if (this.stopped || account.closed) return
          await this.ingest(account, machine, batch)
          for (const file of batch.files) if (!file.pending) state.pending.delete(file.source.id)
          state.warnings = [...new Set([...state.warnings, ...batch.warnings])].slice(0, 10)
        }
        state.checkedAt = new Date().toISOString()
        state.error = null
      } catch (error) {
        state.error = (error as Error).message.slice(0, 400)
      }
    })().finally(() => {
      state.refreshing = null
    })
    return state.refreshing
  }
  private sync(account: Account) {
    if (this.stopped || account.closed) return Promise.resolve()
    account.syncing ??= (async () => {
      const machines = await this.machines(account)
      // Keep SSH fan-out bounded even for workspaces with many targets.
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(3, machines.length) }, async () => {
          while (next < machines.length && !this.stopped) await this.refreshMachine(account, machines[next++])
        }),
      )
      if (!this.stopped && !account.closed && machines.length) this.pumpEmbeddings(account)
    })()
      .catch(error => {
        account.embeddingError = (error as Error).message
      })
      .finally(() => {
        account.syncing = null
        if (
          !this.stopped &&
          !account.closed &&
          [...account.states.values()].some(state => !state.error && (state.after || state.pending.size)) &&
          !account.continuation
        ) {
          account.continuation = setTimeout(() => {
            account.continuation = null
            void this.sync(account)
          }, 100).unref()
        }
      })
    return account.syncing
  }
  private async ingest(account: Account, machine: HistoryMachine, batch: HistoryBatch) {
    // Short transactions keep terminal/HTTP traffic responsive during backfill.
    // The file checkpoint advances only after every part is durably indexed.
    for (const file of batch.files) {
      let start = 0,
        first = true
      do {
        let end = start,
          bytes = 0
        while (end < file.messages.length && end - start < 32 && bytes < 256 * 1024)
          bytes += file.messages[end++].text.length
        account.index.ingest(
          machine,
          { files: [{ ...file, reset: first && file.reset, messages: file.messages.slice(start, end) }], warnings: [] },
          end === file.messages.length,
        )
        first = false
        start = end
        await new Promise<void>(resolve => setImmediate(resolve))
      } while (start < file.messages.length)
    }
  }
  private pumpEmbeddings(account: Account) {
    if (account.embeddingJob || account.closed || this.stopped || Date.now() < account.embeddingRetryAt) return
    account.embeddingJob = (async () => {
      while (!this.stopped && !account.closed) {
        const n = await account.index.embedPending(
          account.machines.map(m => m.id),
          16,
        )
        if (!n) break
        account.embeddingError = null
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    })()
      .catch(error => {
        account.embeddingError = (error as Error).message.slice(0, 300)
        account.embeddingRetryAt = Date.now() + 60000
      })
      .finally(() => {
        account.embeddingJob = null
      })
  }
  async call(owner: Owner, tool: string, args: unknown) {
    if (this.stopped) throw new Error('Outpost history is restarting. Retry shortly.')
    if (!this.dependencies.deployment.account(owner.userId))
      throw new Error('This Outpost account is no longer available.')
    const check = validate.get(tool)
    if (!check || !check(args))
      throw new Error(
        'Invalid history tool arguments. ' +
          (check ? new Ajv().errorsText(check.errors) : 'Unknown Outpost history tool.'),
      )
    const input = args as Record<string, unknown>
    const account = this.account(owner)
    const machines = await this.machines(account)
    let selected = machines
    if (typeof input.machine === 'string') {
      const exact = machines.find(machine => machine.id === input.machine)
      selected = exact ? [exact] : machines.filter(machine => machine.name === input.machine)
      if (selected.length !== 1)
        throw new Error(
          selected.length
            ? 'Several machines have that name. Use a machine ID.'
            : 'That machine is not configured for this account.',
        )
    }
    const ids = selected.map(machine => machine.id)
    if (tool === 'refresh_index') {
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(3, selected.length) }, async () => {
          while (next < selected.length) await this.refreshMachine(account, selected[next++])
        }),
      )
      let embedded = 0
      if (Number(input.embedLimit) > 0) embedded = await account.index.embedPending(ids, Number(input.embedLimit))
      return {
        embedded,
        coverage: account.index.coverage(ids),
        machines: this.status(account, selected),
        note: 'Native source conversations are read-only. Further refreshes continue catalog pages and pending files.',
      }
    }
    if (tool === 'search_history') {
      this.watch(owner)
      const result = await account.index.search(
        { ...input, ...(input.machine ? { machine: selected[0].id } : {}) } as unknown as HistorySearchInput,
        ids,
      )
      const status = this.status(account, selected)
      return {
        ...result,
        machines: status,
        partial:
          status.some(machine => machine.indexing || machine.error || machine.warnings.length) ||
          (result.semanticStatus !== 'not_requested' &&
            result.semanticStatus !== 'literal_query' &&
            result.coverage.pendingChunks > 0),
        ...(account.embeddingError ? { embeddingError: account.embeddingError } : {}),
      }
    }
    if (tool === 'read_context') {
      if (!input.cursor && !input.sessionId) throw new Error('Supply a search cursor or sessionId.')
      return account.index.context(input as Parameters<HistoryIndex['context']>[0], ids)
    }
    if (tool === 'read_message') {
      const pageInput = input as Parameters<HistoryIndex['readMessage']>[0]
      const source = account.index.messageSource(pageInput.cursor, ids)
      const cached = account.index.readMessage(pageInput, ids)
      if (source.truncated && (pageInput.offset ?? 0) >= source.length) {
        const context = await this.dependencies.resolve(owner, source.machineId)
        const page = await this.reader.message(
          context,
          {
            source: source.source,
            position: source.position,
            contentHash: source.contentHash,
            offset: pageInput.offset,
            limit: pageInput.limit,
          },
          AbortSignal.timeout(20000),
        )
        return { ...cached, ...page }
      }
      return cached
    }
    return account.index.session(String(input.sessionId), ids)
  }
  private status(account: Account, machines: HistoryMachine[]) {
    return machines.map(machine => {
      const state = this.state(account, machine.id)
      return {
        ...machine,
        checkedAt: state.checkedAt,
        error: state.error,
        warnings: state.warnings,
        indexing: !state.checkedAt || Boolean(state.after || state.pending.size),
      }
    })
  }
  async close() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const account of this.accounts.values()) if (account.continuation) clearTimeout(account.continuation)
    await Promise.allSettled(
      [...this.accounts.values()].flatMap(account => [
        account.syncing,
        ...[...account.states.values()].map(state => state.refreshing),
      ]),
    )
    for (const account of this.accounts.values()) account.index.close()
    this.accounts.clear()
  }
}
