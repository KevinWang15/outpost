// Prompts Outpost writes on behalf of channels, other sessions and schedules.
// The first line is the header the transcript uses to attribute replayed turns.
import { chatLimits, type Channel, type ChannelMessage } from '../../shared/chatApi'
import { promptHeader } from '../../shared/chatTranscript'

const authorName = (message: ChannelMessage) =>
  message.author.kind === 'user'
    ? 'the user'
    : message.author.kind === 'session'
      ? `@${message.author.handle}`
      : 'Outpost'

/** New channel messages since the member's last turn there, newest last. */
export function channelPrompt(channel: Channel, handle: string, messages: ChannelMessage[]) {
  const lines: string[] = []
  let bytes = 0
  let omitted = 0
  for (const message of [...messages].reverse()) {
    const line = `${authorName(message)}: ${message.text}`
    if (lines.length >= chatLimits.delta || bytes + line.length > chatLimits.deltaBytes) {
      omitted++
      continue
    }
    lines.unshift(line)
    bytes += line.length
  }
  const members = channel.members.map(member => `@${member.handle}`).join(', ')
  return [
    `${promptHeader(`#${channel.name}`)}You are @${handle} in the Outpost channel #${channel.name}${channel.topic ? ` (${channel.topic})` : ''}. Members: ${members}.`,
    `New messages since your last reply${omitted ? ` (${omitted} older not shown)` : ''}:`,
    '',
    ...lines,
    '',
    'Your final message is posted to the channel. To hand work to a member, mention them, e.g. @name.',
  ].join('\n')
}

export function sessionPrompt(from: string, text: string) {
  return [
    `${promptHeader(`From @${from}`)}Message from the Outpost session @${from}:`,
    '',
    text,
    '',
    `Your final message is sent back to @${from} as the reply.`,
  ].join('\n')
}

export function replyPrompt(from: string, text: string) {
  return [
    `${promptHeader(`Reply from @${from}`)}Reply from the Outpost session @${from}:`,
    '',
    text || '(no reply text)',
  ].join('\n')
}

export function schedulePrompt(name: string, text: string) {
  return [`${promptHeader(`Scheduled · ${name}`)}Scheduled task "${name}":`, '', text].join('\n')
}

/** Short display text for an origin. */
export const summary = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}…` : text)
