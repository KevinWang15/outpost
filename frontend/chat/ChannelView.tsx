import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ChevronRight, Hash, Info, LoaderCircle, Settings2, TriangleAlert } from 'lucide-react'
import {
  sessionKey,
  type ChannelMessage,
  type ChannelView as Channel,
  type ChatSession,
  type Delivery,
} from '../../shared/chatApi'
import { Avatar, UserAvatar } from './Avatar'
import { transcriptOf } from './client'
import Composer from './Composer'
import { clock, day, elapsed } from './format'
import { MarkdownContext, useChat } from './context'
import { Markdown } from './Markdown'
import { Reply } from './Turn'

/** A member's steps for one turn, from its own chat. Opening it never starts a coding tool. */
function MemberSteps({ member, turn }: { member: { targetId: string; sessionId: string }; turn: string }) {
  const { client } = useChat()
  const { targetId, sessionId } = member
  const key = sessionKey(member)
  useEffect(() => client.open({ targetId, sessionId }, false), [client, targetId, sessionId])
  const conversation = client.conversations.get(key)
  const view = conversation?.journal ? transcriptOf(conversation.journal) : null
  const found = view?.turns.find(item => item.id === turn)
  if (!view)
    return (
      <p className="member-steps muted">
        {conversation?.link === 'stopped' ? 'This session is not running.' : 'Loading steps…'}
      </p>
    )
  if (!found) return <p className="member-steps muted">These steps are no longer kept in the session’s chat.</p>
  return (
    <div className="member-steps">
      <Reply turn={found} open />
    </div>
  )
}

function Working({ delivery, session }: { delivery: Delivery; session: ChatSession | null }) {
  const [open, setOpen] = useState(false)
  const name = session?.name ?? 'A member'
  return (
    <div className="channel-working">
      <button
        className="channel-working-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={!delivery.turn}
      >
        <Avatar name={name} tool={session?.tool ?? null} session={session} size={22} />
        <span>
          <strong>@{session?.handle ?? 'member'}</strong>{' '}
          {delivery.state === 'pending'
            ? 'is getting the message…'
            : delivery.state === 'sent'
              ? 'will reply after its current work'
              : 'is working…'}
          <span className="muted"> {elapsed(delivery.createdAt)}</span>
        </span>
        {delivery.turn && <ChevronRight size={13} className="chevron" />}
      </button>
      {open && delivery.turn && <MemberSteps member={delivery} turn={delivery.turn} />}
    </div>
  )
}

function Message({ message, grouped, channel }: { message: ChannelMessage; grouped: boolean; channel: Channel }) {
  const { client, select } = useChat()
  const [steps, setSteps] = useState(false)
  const { author } = message
  if (author.kind === 'outpost')
    return (
      <div className={`channel-notice ${author.level}`}>
        {author.level === 'info' ? <Info size={13} /> : <TriangleAlert size={13} />}
        {message.text}
      </div>
    )
  const session = author.kind === 'session' ? client.session(author) : null
  const name = author.kind === 'session' ? author.name : 'You'
  const member =
    author.kind === 'session' ? channel.members.find(item => sessionKey(item) === sessionKey(author)) : null
  return (
    <div className={`channel-message ${grouped ? 'grouped' : ''}`}>
      <div className="channel-avatar">
        {grouped ? (
          <time dateTime={message.at}>{clock(message.at)}</time>
        ) : author.kind === 'session' ? (
          <Avatar name={name} tool={session?.tool ?? null} session={session} size={32} />
        ) : (
          <UserAvatar size={32} />
        )}
      </div>
      <div className="channel-body">
        {!grouped && (
          <div className="channel-author">
            {author.kind === 'session' ? (
              <button
                className="link"
                onClick={() => select({ kind: 'session', targetId: author.targetId, sessionId: author.sessionId })}
              >
                {name}
              </button>
            ) : (
              <strong>{name}</strong>
            )}
            {author.kind === 'session' && <span className="muted">@{member?.handle ?? author.handle}</span>}
            <time dateTime={message.at}>{clock(message.at)}</time>
          </div>
        )}
        <Markdown text={message.text} />
        {message.turn && (
          <button className="link small" aria-expanded={steps} onClick={() => setSteps(!steps)}>
            <ChevronRight size={12} className={steps ? 'chevron open' : 'chevron'} />
            Steps
          </button>
        )}
        {steps && message.turn && <MemberSteps member={message.turn} turn={message.turn.turn} />}
      </div>
    </div>
  )
}

export default function ChannelView({ channelId, onBack }: { channelId: string; onBack: () => void }) {
  const { client, open, openLink } = useChat()
  const channel = client.channels.get(channelId)
  const state = client.channelMessages.get(channelId)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [behind, setBehind] = useState(false)
  const handles = useMemo(() => channel?.members.map(member => member.handle) ?? [], [channel])

  useEffect(() => {
    pinned.current = true
    if (client.status === 'live') void client.loadChannel(channelId, true)
  }, [client, channelId, client.status])
  const last = state?.messages.at(-1)?.id
  useEffect(() => {
    if (!last) return
    const read = () => document.visibilityState === 'visible' && void client.readChannel(channelId)
    read()
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [client, channelId, last])
  const working = [...client.deliveries.values()].filter(
    delivery =>
      delivery.source.kind === 'channel' &&
      delivery.source.channelId === channelId &&
      (delivery.state === 'pending' || delivery.state === 'sent' || delivery.state === 'running'),
  )
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (pinned.current) element.scrollTop = element.scrollHeight
    else setBehind(true)
  }, [state?.messages, working.length])

  if (!channel)
    return (
      <section className="conversation">
        <div className="empty">
          <p>This channel no longer exists.</p>
        </div>
      </section>
    )
  const messages = state?.messages ?? []
  const members = channel.members.map(member => ({ member, session: client.session(member) }))
  return (
    <MarkdownContext.Provider value={{ handles, openLink }}>
      <section className="conversation channel">
        <header className="conversation-header">
          <button className="icon-button back" aria-label="Back to the list" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
          <span className="channel-icon">
            <Hash size={18} />
          </span>
          <div className="conversation-title">
            <h1>{channel.name}</h1>
            <p>{channel.topic || `${channel.members.length} ${channel.members.length === 1 ? 'member' : 'members'}`}</p>
          </div>
          <div className="member-stack" aria-label="Members">
            {members.slice(0, 6).map(({ member, session }) => (
              <Avatar
                key={sessionKey(member)}
                name={member.name}
                tool={session?.tool ?? null}
                session={session}
                size={26}
              />
            ))}
          </div>
          <button
            className="icon-button"
            aria-label="Channel settings"
            title="Channel settings"
            onClick={() => open({ kind: 'channel', channelId })}
          >
            <Settings2 size={16} />
          </button>
        </header>
        <div
          className="transcript"
          ref={scroller}
          onScroll={event => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
            if (pinned.current) setBehind(false)
            if (element.scrollTop < 40 && state?.more && !state.loading) void client.loadChannel(channelId)
          }}
        >
          <div className="transcript-inner channel-messages">
            {state?.more && (
              <button
                className="button small more"
                disabled={state.loading}
                onClick={() => void client.loadChannel(channelId)}
              >
                {state.loading ? 'Loading…' : 'Load earlier messages'}
              </button>
            )}
            {!messages.length && !state?.loading && (
              <div className="transcript-empty">
                <span className="channel-icon large">
                  <Hash size={26} />
                </span>
                <h2>#{channel.name}</h2>
                <p>
                  Sessions here reply when you mention them, like <code>@{handles[0] ?? 'name'}</code>. A reply that
                  mentions another member passes the conversation on. <code>@all</code> asks everyone.
                </p>
              </div>
            )}
            {state?.loading && !messages.length && <LoaderCircle className="spin" size={18} />}
            {messages.map((message, index) => {
              const previous = messages[index - 1]
              const newDay = !previous || day(previous.at) !== day(message.at)
              const grouped =
                !newDay &&
                previous.author.kind === message.author.kind &&
                message.author.kind !== 'outpost' &&
                (message.author.kind === 'user' ||
                  (previous.author.kind === 'session' &&
                    message.author.kind === 'session' &&
                    sessionKey(previous.author) === sessionKey(message.author))) &&
                new Date(message.at).getTime() - new Date(previous.at).getTime() < 5 * 60_000
              return (
                <div key={message.id}>
                  {newDay && <div className="day">{day(message.at)}</div>}
                  <Message message={message} grouped={grouped} channel={channel} />
                </div>
              )
            })}
            {working.map(delivery => (
              <Working key={delivery.id} delivery={delivery} session={client.session(delivery)} />
            ))}
          </div>
        </div>
        {behind && (
          <button
            className="jump"
            onClick={() => {
              const element = scroller.current
              if (element) element.scrollTop = element.scrollHeight
              pinned.current = true
              setBehind(false)
            }}
          >
            <ArrowDown size={14} /> Latest
          </button>
        )}
        <footer className="conversation-footer">
          <Composer
            draftKey={`channel:${channelId}`}
            placeholder={`Message #${channel.name} — mention @${handles[0] ?? 'a member'} to ask it`}
            images={false}
            mentions={[
              ...members.map(({ member, session }) => ({
                value: member.handle,
                label: member.name,
                detail: session ? `${session.target} · ${session.rootDir}` : member.name,
              })),
              { value: 'all', label: 'Everyone in this channel' },
            ]}
            disabled={channel.members.length ? null : 'Add members in channel settings first.'}
            onSend={async text => {
              pinned.current = true
              await client.call({ type: 'channel-post', channelId, key: crypto.randomUUID().replace(/-/g, ''), text })
            }}
          />
        </footer>
      </section>
    </MarkdownContext.Provider>
  )
}
