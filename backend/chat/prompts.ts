// Prompts Outpost writes on behalf of channels, other sessions and schedules.
// The first line is the header the transcript uses to attribute replayed turns.
// What is asked comes next, as its first paragraph, and the instructions for
// answering after it; a conversation's title is the header and that paragraph.
import { chatLimits, type Channel, type ChannelMessage } from '../../shared/chatApi'
import { promptHeader } from '../../shared/chatTranscript'

const fileNames = (message: ChannelMessage) =>
  message.files.length ? ` [attached: ${message.files.map(file => file.name).join(', ')}]` : ''
const authorName = (message: ChannelMessage) =>
  message.author.kind === 'user'
    ? 'the user'
    : message.author.kind === 'session'
      ? `@${message.author.handle}`
      : 'Outpost'

/** New channel messages since the member's last turn there, newest last.
 * `missing` lists attached files that could not be given to the member. */
export function channelPrompt(channel: Channel, handle: string, messages: ChannelMessage[], missing: string[] = []) {
  const lines: string[] = []
  let bytes = 0
  let omitted = 0
  for (const message of [...messages].reverse()) {
    const line = `${authorName(message)}: ${message.text}${fileNames(message)}`
    if (lines.length >= chatLimits.delta || bytes + line.length > chatLimits.deltaBytes) {
      omitted++
      continue
    }
    lines.unshift(line)
    bytes += line.length
  }
  const members = channel.members.map(member => `@${member.handle}`).join(', ')
  return [
    `${promptHeader(`#${channel.name}`)}${lines.join('\n')}`,
    '',
    `You are @${handle} in the Outpost channel #${channel.name}${channel.topic ? ` (${channel.topic})` : ''}. Members: ${members}. Above are the new messages since your last reply, oldest first${omitted ? `; ${omitted} older ones are not shown` : ''}.`,
    ...(missing.length ? [`Files that could not be attached: ${missing.join('; ')}.`] : []),
    'Your final message is posted to the channel. To hand work to a member, mention them, e.g. @name.',
  ].join('\n')
}

export function sessionPrompt(from: string, text: string) {
  return [
    `${promptHeader(`From @${from}`)}${text}`,
    '',
    `This is a message from the Outpost session @${from}. Your final message is sent back to @${from} as the reply.`,
  ].join('\n')
}

export function replyPrompt(from: string, text: string) {
  return [
    `${promptHeader(`Reply from @${from}`)}${text || '(no reply text)'}`,
    '',
    `This is the reply from the Outpost session @${from}.`,
  ].join('\n')
}

export function schedulePrompt(name: string, text: string) {
  return [`${promptHeader(`Scheduled · ${name}`)}${text}`, '', `This is the scheduled task "${name}".`].join('\n')
}

/** Short display text for an origin. */
export const summary = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}…` : text)
