// A small, safe Markdown renderer for agent replies. It builds React elements
// (never HTML strings) and links only http(s) and mailto URLs.
import { memo, useContext, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../api'
import { MarkdownContext } from './context'

const safeUrl = (url: string) => {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : null
  } catch {
    return null
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const { openLink } = useContext(MarkdownContext)
  const url = safeUrl(href)
  if (!url) return <>{children}</>
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={event => {
        event.preventDefault()
        openLink(url)
      }}
    >
      {children}
    </a>
  )
}

const patterns: [RegExp, (match: RegExpExecArray, key: number) => ReactNode][] = [
  [/(`+)([\s\S]+?)\1/y, (m, key) => <code key={key}>{m[2].trim() || m[2]}</code>],
  [/\*\*(?=\S)([\s\S]+?\S)\*\*/y, (m, key) => <strong key={key}>{inline(m[1])}</strong>],
  [/__(?=\S)([\s\S]+?\S)__(?!\w)/y, (m, key) => <strong key={key}>{inline(m[1])}</strong>],
  [/\*(?=[^\s*])([^*\n]+?)\*(?!\*)/y, (m, key) => <em key={key}>{inline(m[1])}</em>],
  [/_(?=[^\s_])([^_\n]+?)_(?!\w)/y, (m, key) => <em key={key}>{inline(m[1])}</em>],
  [/~~(?=\S)([\s\S]+?\S)~~/y, (m, key) => <del key={key}>{inline(m[1])}</del>],
  [
    /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/y,
    (m, key) => (
      <Link key={key} href={m[2]}>
        {inline(m[1])}
      </Link>
    ),
  ],
  [
    /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/y,
    (m, key) => (
      <Link key={key} href={m[0]}>
        {m[0]}
      </Link>
    ),
  ],
]
const triggers = new Set(['`', '*', '_', '~', '[', 'h', '@'])

function Mention({ handle }: { handle: string }) {
  const { handles } = useContext(MarkdownContext)
  const known = handles.includes(handle) || ['all', 'channel', 'here'].includes(handle)
  return known ? <span className="mention">@{handle}</span> : <>@{handle}</>
}

/** Inline spans: code, emphasis, links and @mentions. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let plain = ''
  let index = 0
  const flush = () => {
    if (plain) nodes.push(plain)
    plain = ''
  }
  while (index < text.length) {
    const char = text[index]
    let matched = false
    if (triggers.has(char)) {
      if (char === '@' && !/[\w@./-]/.test(text[index - 1] ?? '')) {
        const mention = /@([a-z0-9][a-z0-9-]{0,47})/iy
        mention.lastIndex = index
        const m = mention.exec(text)
        if (m) {
          flush()
          nodes.push(<Mention key={nodes.length} handle={m[1].toLowerCase().replace(/-+$/, '')} />)
          index += m[0].length
          matched = true
        }
      } else if (char !== 'h' || !/\w/.test(text[index - 1] ?? '')) {
        for (const [pattern, render] of patterns) {
          pattern.lastIndex = index
          const m = pattern.exec(text)
          if (m) {
            flush()
            nodes.push(render(m, nodes.length))
            index += m[0].length
            matched = true
            break
          }
        }
      }
    }
    if (!matched) {
      plain += char
      index++
    }
  }
  flush()
  return nodes
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language}</span>
        <button
          className="icon-button"
          aria-label="Copy code"
          title="Copy"
          onClick={() =>
            void copyText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const blockStart = /^(\s*(```|~~~)|#{1,6}\s|>|\s*([-*+]|\d{1,9}[.)])\s+|\s*([-*_])(\s*\4){2,}\s*$)/
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const key = out.length
    if (!line.trim()) {
      index++
      continue
    }
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/)
    if (fence) {
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++])
      index++
      out.push(<CodeBlock key={key} code={body.join('\n')} language={fence[2]} />)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(6, heading[1].length + 2)
      const Tag = `h${level}` as 'h3'
      out.push(<Tag key={key}>{inline(heading[2])}</Tag>)
      index++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key} />)
      index++
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length && lines[index].startsWith('>')) quoted.push(lines[index++].replace(/^>\s?/, ''))
      out.push(<blockquote key={key}>{blocks(quoted.join('\n'))}</blockquote>)
      continue
    }
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])
    ) {
      const head = cells(line)
      const align = cells(lines[index + 1]).map(cell =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : undefined,
      )
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]))
      out.push(
        <div key={key} className="table-scroll">
          <table>
            <thead>
              <tr>
                {head.map((cell, column) => (
                  <th key={column} style={{ textAlign: align[column] }}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, number) => (
                <tr key={number}>
                  {head.map((_, column) => (
                    <td key={column} style={{ textAlign: align[column] }}>
                      {inline(row[column] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    const item = line.match(listItem)
    if (item) {
      const ordered = /\d/.test(item[2])
      const indent = item[1].length
      const items: string[][] = []
      while (index < lines.length) {
        const current = lines[index]
        const match = current.match(listItem)
        if (match && match[1].length <= indent && /\d/.test(match[2]) === ordered) {
          items.push([match[3]])
          index++
        } else if (items.length && current.trim() && (/^\s/.test(current) || !blockStart.test(current))) {
          items[items.length - 1].push(current.replace(new RegExp(`^\\s{0,${indent + 4}}`), ''))
          index++
        } else if (!current.trim() && lines[index + 1]?.match(listItem)) index++
        else break
      }
      const start = ordered ? Number.parseInt(item[2], 10) : undefined
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={key} start={start !== 1 ? start : undefined}>
          {items.map((body, number) => {
            const [first, ...rest] = body
            const task = first.match(/^\[([ xX])\]\s+(.*)$/)
            return (
              <li key={number} className={task ? 'task' : undefined}>
                {task && <input type="checkbox" checked={task[1] !== ' '} readOnly aria-label="Task" />}
                {inline(task ? task[2] : first)}
                {rest.length > 0 && blocks(rest.join('\n'))}
              </li>
            )
          })}
        </List>,
      )
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !(paragraph.length && blockStart.test(lines[index])))
      paragraph.push(lines[index++])
    out.push(
      <p key={key}>
        {paragraph.flatMap((text, number) => (number ? [<br key={`br${number}`} />, ...inline(text)] : inline(text)))}
      </p>,
    )
  }
  return out
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text)}</div>
})
