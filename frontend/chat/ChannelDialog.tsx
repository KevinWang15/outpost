import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { harnessLabel } from '../../shared/harnesses'
import { chatLimits, sessionKey, type ChannelMember, type ChannelView } from '../../shared/chatApi'
import { Dialog } from '../ui/Dialog'
import { Avatar } from './Avatar'
import { plainRef } from './client'
import { useChat } from './context'
import { DialogFooter } from './Dialogs'

export function ChannelDialog({
  channelId,
  membersOnly = false,
  onClose,
}: {
  channelId: string | null
  membersOnly?: boolean
  onClose: () => void
}) {
  const { client, select } = useChat()
  const existing = channelId ? client.channels.get(channelId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [topic, setTopic] = useState(existing?.topic ?? '')
  const [changes, setChanges] = useState(new Map<string, boolean>())
  const [search, setSearch] = useState('')
  const current = new Map(existing?.members.map(member => [sessionKey(member), member]))
  // Stored members remain visible and removable even when their machine is offline.
  const candidates = new Map<string, ChannelMember>(current)
  for (const session of client.sessions) {
    const ref = { targetId: session.targetId, sessionId: session.id }
    const key = sessionKey(ref)
    candidates.set(key, { ...ref, name: session.name, handle: current.get(key)?.handle ?? session.handle })
  }
  const selected = (key: string) => changes.get(key) ?? current.has(key)
  const roster = [...candidates].filter(([key]) => selected(key))
  const query = search.trim().toLowerCase()
  const options = [...candidates]
    .map(([key, member]) => {
      const session = client.session(member)
      const target = client.targets.find(target => target.id === member.targetId)
      const machine = target?.name ?? member.targetId
      const detail = [
        `@${member.handle}`,
        machine,
        target?.error || !session ? 'Unavailable' : harnessLabel(session.tool),
      ].join(' · ')
      return { key, member, session, detail }
    })
    .filter(({ member, detail }) => `${member.name} ${detail}`.toLowerCase().includes(query))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const channel = !channelId
        ? { name, topic, members: roster.map(([, member]) => plainRef(member)) }
        : membersOnly
          ? {
              id: channelId,
              add: roster.filter(([key]) => !current.has(key)).map(([, member]) => plainRef(member)),
              remove: [...current].filter(([key]) => !selected(key)).map(([, member]) => plainRef(member)),
            }
          : { id: channelId, name, topic }
      const saved = await client.call<ChannelView>({ type: 'channel-save', channel })
      select({ kind: 'channel', channelId: saved.id })
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={membersOnly ? `Members of #${existing?.name ?? ''}` : existing ? `#${existing.name}` : 'New channel'}
      description={membersOnly ? undefined : 'Mention a member to ask it to reply, or use @all to ask everyone.'}
      busy={busy}
      onClose={onClose}
      footer={
        <DialogFooter
          busy={busy}
          onClose={onClose}
          action={membersOnly ? 'Save members' : existing ? 'Save' : 'Create channel'}
          form="channel-form"
          danger={
            existing &&
            !membersOnly && (
              <button
                className={`button ${confirmDelete ? 'danger' : ''} push-left`}
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!confirmDelete) return setConfirmDelete(true)
                  setBusy(true)
                  try {
                    await client.call({ type: 'channel-delete', channelId: existing.id })
                    select(null)
                    onClose()
                  } catch (problem) {
                    setError((problem as Error).message)
                    setBusy(false)
                  }
                }}
              >
                <Trash2 size={14} /> {confirmDelete ? 'Delete channel and messages' : 'Delete'}
              </button>
            )
          }
        />
      }
    >
      <form id="channel-form" className="form" onSubmit={submit}>
        {!membersOnly && (
          <>
            <label className="field">
              <span className="label">Name</span>
              <div className="prefixed">
                <span>#</span>
                <input
                  required
                  autoFocus
                  value={name}
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9_\-]*"
                  placeholder="release"
                  onChange={event =>
                    setName(
                      event.target.value
                        .toLowerCase()
                        .replace(/\s+/g, '-')
                        .replace(/[^a-z0-9_-]/g, ''),
                    )
                  }
                />
              </div>
            </label>
            <label className="field">
              <span className="label">Topic</span>
              <input
                value={topic}
                maxLength={500}
                placeholder="Ship version 1.2"
                onChange={event => setTopic(event.target.value)}
              />
            </label>
          </>
        )}
        {(!existing || membersOnly) && (
          <fieldset className="field">
            <legend className="label">
              Members ({roster.length}/{chatLimits.members})
            </legend>
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search by session, handle, or machine"
              autoFocus={membersOnly}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <div className="member-picker">
              {[true, false].map(inChannel => {
                const rows = options.filter(row => current.has(row.key) === inChannel)
                if (!rows.length) return null
                return (
                  <div key={String(inChannel)}>
                    <h4>{inChannel ? 'In this channel' : 'Available sessions'}</h4>
                    {rows.map(({ key, member, session, detail }) => (
                      <label key={key} className="member-option">
                        <input
                          type="checkbox"
                          checked={selected(key)}
                          disabled={!selected(key) && roster.length >= chatLimits.members}
                          onChange={event => setChanges(new Map(changes).set(key, event.target.checked))}
                        />
                        <Avatar id={member.sessionId} name={member.name} tool={session?.tool ?? null} size={26} />
                        <span>
                          <strong>{session?.name ?? member.name}</strong>
                          <small>{detail}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )
              })}
              {!options.length && <p className="muted">{query ? 'No matching sessions.' : 'No sessions available.'}</p>}
            </div>
          </fieldset>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  )
}
