// Safe React-element Markdown renderer for the User Guide.
// Supports headings with stable anchor IDs, GitHub-style callouts, fenced code
// blocks with copy buttons, GFM tables, lists, and in-app guide navigation.
import { memo, useState, type MouseEvent, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Check, Copy, Info, Lightbulb, Link as LinkIcon } from 'lucide-react'
import { createHeadingSlugger, guideHref, resolveGuideLink } from '../../shared/guide'
import { copyText } from '../api'

type CalloutKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

const calloutMeta: Record<CalloutKind, { label: string; className: string; Icon: typeof Info }> = {
  NOTE: { label: 'Note', className: 'note', Icon: Info },
  TIP: { label: 'Tip', className: 'tip', Icon: Lightbulb },
  IMPORTANT: { label: 'Important', className: 'important', Icon: AlertCircle },
  WARNING: { label: 'Warning', className: 'warning', Icon: AlertTriangle },
  CAUTION: { label: 'Caution', className: 'caution', Icon: AlertTriangle },
}

interface RenderContext {
  knownSlugs: ReadonlySet<string>
  onNavigate: (slug: string, hash?: string) => void
  onAnchor: (hash: string) => void
  slugger: (text: string) => string
}

function GuideLink({ href, children, ctx }: { href: string; children: ReactNode; ctx: RenderContext }) {
  const resolved = resolveGuideLink(href, ctx.knownSlugs)
  if (!resolved) return <>{children}</>

  if (resolved.kind === 'guide') {
    const targetHref = guideHref(resolved.slug, resolved.hash)
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      ctx.onNavigate(resolved.slug, resolved.hash)
    }
    return (
      <a href={targetHref} onClick={handleClick}>
        {children}
      </a>
    )
  }

  if (resolved.kind === 'anchor') {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      ctx.onAnchor(resolved.hash)
    }
    return (
      <a href={`#${resolved.hash}`} onClick={handleClick}>
        {children}
      </a>
    )
  }

  if (resolved.kind === 'app') {
    return <a href={resolved.href}>{children}</a>
  }

  return (
    <a href={resolved.href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function inline(text: string, ctx: RenderContext): ReactNode[] {
  const patterns: [RegExp, (match: RegExpExecArray, key: number) => ReactNode][] = [
    [/(`+)([\s\S]+?)\1/y, (m, key) => <code key={key}>{m[2].trim() || m[2]}</code>],
    [/\*\*(?=\S)([\s\S]+?\S)\*\*/y, (m, key) => <strong key={key}>{inline(m[1], ctx)}</strong>],
    [/__(?=\S)([\s\S]+?\S)__(?!\w)/y, (m, key) => <strong key={key}>{inline(m[1], ctx)}</strong>],
    [/\*(?=[^\s*])([^*\n]+?)\*(?!\*)/y, (m, key) => <em key={key}>{inline(m[1], ctx)}</em>],
    [/_(?=[^\s_])([^_\n]+?)_(?!\w)/y, (m, key) => <em key={key}>{inline(m[1], ctx)}</em>],
    [/~~(?=\S)([\s\S]+?\S)~~/y, (m, key) => <del key={key}>{inline(m[1], ctx)}</del>],
    [
      /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/y,
      (m, key) => (
        <GuideLink key={key} href={m[2]} ctx={ctx}>
          {inline(m[1], ctx)}
        </GuideLink>
      ),
    ],
    [
      /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/y,
      (m, key) => (
        <GuideLink key={key} href={m[0]} ctx={ctx}>
          {m[0]}
        </GuideLink>
      ),
    ],
  ]
  const triggers = new Set(['`', '*', '_', '~', '[', 'h'])
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
    if (triggers.has(char) && (char !== 'h' || !/\w/.test(text[index - 1] ?? ''))) {
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
    <div className="guide-code-block">
      <div className="guide-code-bar">
        <span>{language || 'text'}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy code"
          title="Copy code"
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

    // Fenced code block
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/)
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
      out.push(<CodeBlock key={key} code={body.join('\n')} language={fence[2]} />)
      continue
    }

    // Headings (H1..H6) with matching deduplicated anchor IDs
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      const id = ctx.slugger(heading[2])
      const content = inline(heading[2], ctx)
      const anchor =
        level >= 2 && level <= 3 ? (
          <a
            className="guide-heading-anchor"
            href={`#${id}`}
            aria-label={`Link to ${heading[2]}`}
            onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
              event.preventDefault()
              ctx.onAnchor(id)
            }}
          >
            <LinkIcon size={14} />
          </a>
        ) : null
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      out.push(
        <Tag key={key} id={id} className="guide-heading">
          <span>{content}</span>
          {anchor}
        </Tag>,
      )
      index++
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key} />)
      index++
      continue
    }

    // Blockquote / GitHub-style admonition callout
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length && lines[index].startsWith('>')) {
        quoted.push(lines[index++].replace(/^>\s?/, ''))
      }
      const alertMatch = quoted[0]?.trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/)
      if (alertMatch) {
        const kind = alertMatch[1] as CalloutKind
        const meta = calloutMeta[kind]
        const Icon = meta.Icon
        const inner = quoted.slice(1).join('\n')
        out.push(
          <aside key={key} className={`guide-callout guide-callout-${meta.className}`} role="note">
            <div className="guide-callout-title">
              <Icon size={15} />
              <span>{meta.label}</span>
            </div>
            <div className="guide-callout-body">{renderBlocks(inner, ctx)}</div>
          </aside>,
        )
      } else {
        out.push(<blockquote key={key}>{renderBlocks(quoted.join('\n'), ctx)}</blockquote>)
      }
      continue
    }

    // GFM Table
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
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index++]))
      }
      out.push(
        <div key={key} className="guide-table-scroll">
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
        </div>,
      )
      continue
    }

    // Lists (ordered, unordered, nested, task lists)
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
        } else if (!current.trim() && lines[index + 1]?.match(listItem)) {
          index++
        } else {
          break
        }
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

    // Paragraph
    const paragraph: string[] = [line]
    index++
    while (index < lines.length && lines[index].trim() && !blockStart.test(lines[index])) {
      paragraph.push(lines[index++])
    }
    out.push(<p key={key}>{inline(paragraph.join('\n'), ctx)}</p>)
  }

  return out
}

export const GuideMarkdown = memo(function GuideMarkdown({
  content,
  knownSlugs,
  onNavigate,
  onAnchor,
}: {
  content: string
  knownSlugs: ReadonlySet<string>
  onNavigate: (slug: string, hash?: string) => void
  onAnchor: (hash: string) => void
}) {
  const ctx: RenderContext = {
    knownSlugs,
    onNavigate,
    onAnchor,
    slugger: createHeadingSlugger(),
  }
  return <div className="guide-prose">{renderBlocks(content, ctx)}</div>
})
