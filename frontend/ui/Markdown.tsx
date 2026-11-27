// Safe React-element Markdown renderer shared by Chat and the User Guide.
// Builds React elements (never HTML strings) and defaults to safe http(s)/mailto links.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../browser'

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

function defaultLink(href: string, children: ReactNode, key: number): ReactNode {
  const url = safeUrl(href)
  if (!url) return <span key={key}>{children}</span>
  return (
    <a key={key} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

interface RenderContext {
  mentions?: readonly string[]
  renderLink: (href: string, children: ReactNode, key: number) => ReactNode
  renderImage?: (src: string, alt: string, key: number, block: boolean) => ReactNode
  renderCodeBlock?: (code: string, language: string, key: number) => ReactNode
  renderTable?: (table: ReactNode, key: number) => ReactNode
  renderBlockquote?: (quotedLines: string[], renderNested: (markdown: string) => ReactNode[], key: number) => ReactNode
  headingOffset: number
  renderHeading?: (level: number, raw: string, children: ReactNode, key: number) => ReactNode
  softBreaks: boolean
  defaultCodeLanguage: string
}

const inlinePatterns: [RegExp, (match: RegExpExecArray, key: number, ctx: RenderContext) => ReactNode][] = [
  [/(`+)([\s\S]+?)\1/y, (m, key) => <code key={key}>{m[2].trim() || m[2]}</code>],
  [/\*\*(?=\S)([\s\S]*?\S)\*\*/y, (m, key, ctx) => <strong key={key}>{inline(m[1], ctx)}</strong>],
  [/__(?=\S)([\s\S]*?\S)__(?!\w)/y, (m, key, ctx) => <strong key={key}>{inline(m[1], ctx)}</strong>],
  [/\*(?=[^\s*])([^*\n]+?)\*(?!\*)/y, (m, key, ctx) => <em key={key}>{inline(m[1], ctx)}</em>],
  [/_(?=[^\s_])([^_\n]+?)_(?!\w)/y, (m, key, ctx) => <em key={key}>{inline(m[1], ctx)}</em>],
  [/~~(?=\S)([\s\S]*?\S)~~/y, (m, key, ctx) => <del key={key}>{inline(m[1], ctx)}</del>],
  [
    /!\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/y,
    (m, key, ctx) => (ctx.renderImage ? ctx.renderImage(m[2], m[1], key, false) : m[0]),
  ],
  [/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/y, (m, key, ctx) => ctx.renderLink(m[2], inline(m[1], ctx), key)],
  [/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/y, (m, key, ctx) => ctx.renderLink(m[0], m[0], key)],
]

const baseTriggers = new Set(['`', '*', '_', '~', '!', '[', 'h'])

function inline(text: string, ctx: RenderContext): ReactNode[] {
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
    if (char === '@' && ctx.mentions !== undefined) {
      if (!/[\w@./-]/.test(text[index - 1] ?? '')) {
        const mention = /@([a-z0-9][a-z0-9-]{0,47})/iy
        mention.lastIndex = index
        const m = mention.exec(text)
        if (m) {
          flush()
          const handle = m[1].toLowerCase().replace(/-+$/, '')
          const known = ctx.mentions.includes(handle) || ['all', 'channel', 'here'].includes(handle)
          nodes.push(
            known ? (
              <span key={nodes.length} className="mention">
                @{handle}
              </span>
            ) : (
              `@${handle}`
            ),
          )
          index += m[0].length
          matched = true
        }
      }
    } else if (baseTriggers.has(char) && (char !== 'h' || !/\w/.test(text[index - 1] ?? ''))) {
      for (const [pattern, render] of inlinePatterns) {
        pattern.lastIndex = index
        const m = pattern.exec(text)
        if (m) {
          flush()
          nodes.push(render(m, nodes.length, ctx))
          index += m[0].length
          matched = true
          break
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

export function CodeBlock({
  code,
  language,
  defaultLanguage = '',
  children,
}: {
  code: string
  language: string
  defaultLanguage?: string
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language || defaultLanguage}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={copied ? 'Copied code' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          onClick={() =>
            void copyText(code)
              .then(() => {
                setCopied(true)
                clearTimeout(timer.current)
                timer.current = setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        <code>{children ?? code}</code>
      </pre>
    </div>
  )
}

const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const blockStart = /^(\s*(```|~~~)|#{1,6}\s|>|\s*([-*+]|\d{1,9}[.)])\s+|\s*([-*_])(\s*\4){2,}\s*$)/
const standaloneImage = /^\s*!\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)\s*$/
const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'))

function renderBlocks(source: string, ctx: RenderContext): ReactNode[] {
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
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.()-]*)/)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      index++
      while (index < lines.length) {
        const trimmed = lines[index].trim()
        if (trimmed.startsWith(marker[0].repeat(marker.length)) && trimmed.replaceAll(marker[0], '') === '') break
        body.push(lines[index++])
      }
      index++
      const code = body.join('\n')
      const language = fence[2]
      if (ctx.renderCodeBlock) {
        out.push(ctx.renderCodeBlock(code, language, key))
      } else {
        out.push(<CodeBlock key={key} code={code} language={language} defaultLanguage={ctx.defaultCodeLanguage} />)
      }
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(6, heading[1].length + ctx.headingOffset)
      const children = inline(heading[2], ctx)
      if (ctx.renderHeading) {
        out.push(ctx.renderHeading(level, heading[2], children, key))
      } else {
        const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        out.push(<Tag key={key}>{children}</Tag>)
      }
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
      if (ctx.renderBlockquote) {
        out.push(ctx.renderBlockquote(quoted, md => renderBlocks(md, ctx), key))
      } else {
        out.push(<blockquote key={key}>{renderBlocks(quoted.join('\n'), ctx)}</blockquote>)
      }
      continue
    }
    if (
      line.includes('|') &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index + 1])
    ) {
      const head = tableCells(line)
      const align = tableCells(lines[index + 1]).map(cell =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : undefined,
      )
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim())
        rows.push(tableCells(lines[index++]))
      const table = (
        <table>
          <thead>
            <tr>
              {head.map((cell, column) => (
                <th key={column} style={{ textAlign: align[column] }}>
                  {inline(cell, ctx)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, number) => (
              <tr key={number}>
                {head.map((_, column) => (
                  <td key={column} style={{ textAlign: align[column] }}>
                    {inline(row[column] ?? '', ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      if (ctx.renderTable) {
        out.push(ctx.renderTable(table, key))
      } else {
        out.push(
          <div key={key} className="table-scroll">
            {table}
          </div>,
        )
      }
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
        <List key={key} start={start && start !== 1 ? start : undefined}>
          {items.map((body, number) => {
            const [first, ...rest] = body
            const task = first.match(/^\[([ xX])\]\s+(.*)$/)
            return (
              <li key={number} className={task ? 'task' : undefined}>
                {task && <input type="checkbox" checked={task[1] !== ' '} readOnly aria-label="Task" />}
                {inline(task ? task[2] : first, ctx)}
                {rest.length > 0 && renderBlocks(rest.join('\n'), ctx)}
              </li>
            )
          })}
        </List>,
      )
      continue
    }
    if (ctx.renderImage) {
      const image = line.match(standaloneImage)
      if (image) {
        out.push(ctx.renderImage(image[2], image[1], key, true))
        index++
        continue
      }
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !(paragraph.length && (blockStart.test(lines[index]) || (ctx.renderImage && standaloneImage.test(lines[index]))))
    )
      paragraph.push(lines[index++])
    out.push(
      <p key={key}>
        {ctx.softBreaks
          ? paragraph.flatMap((text, number) =>
              number ? [<br key={`br${number}`} />, ...inline(text, ctx)] : inline(text, ctx),
            )
          : inline(paragraph.join('\n'), ctx)}
      </p>,
    )
  }
  return out
}

export interface MarkdownProps {
  text: string
  className?: string
  mentions?: readonly string[]
  renderLink?: (href: string, children: ReactNode, key: number) => ReactNode
  renderImage?: (src: string, alt: string, key: number, block: boolean) => ReactNode
  renderCodeBlock?: (code: string, language: string, key: number) => ReactNode
  renderTable?: (table: ReactNode, key: number) => ReactNode
  renderBlockquote?: (quotedLines: string[], renderNested: (markdown: string) => ReactNode[], key: number) => ReactNode
  headingOffset?: number
  createHeadingRenderer?: () => (level: number, raw: string, children: ReactNode, key: number) => ReactNode
  softBreaks?: boolean
  defaultCodeLanguage?: string
}

export const Markdown = memo(function Markdown({
  text,
  className = 'markdown',
  mentions,
  renderLink = defaultLink,
  renderImage,
  renderCodeBlock,
  renderTable,
  renderBlockquote,
  headingOffset = 2,
  createHeadingRenderer,
  softBreaks = true,
  defaultCodeLanguage = '',
}: MarkdownProps) {
  const ctx: RenderContext = {
    mentions,
    renderLink,
    renderImage,
    renderCodeBlock,
    renderTable,
    renderBlockquote,
    headingOffset,
    renderHeading: createHeadingRenderer?.(),
    softBreaks,
    defaultCodeLanguage,
  }
  return <div className={className}>{renderBlocks(text, ctx)}</div>
})
