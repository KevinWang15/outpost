// Interactive User Guide widgets styled with Outpost's design system:
// zoomable/pannable image lightbox, expandable table modal, syntax-highlighted code blocks,
// scaled controlled HTML/SVG previews, and GitHub-style alert callouts.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, Info, Lightbulb, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { CodeBlock } from '../ui/Markdown'

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const CALLOUT_META: Record<CalloutKind, { label: string; Icon: typeof Info }> = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: AlertCircle },
  warning: { label: 'Warning', Icon: AlertTriangle },
  caution: { label: 'Caution', Icon: AlertTriangle },
}

function useLightboxBodyLock(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = originalOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])
}

/** Render GitHub `[!NOTE]`/`[!TIP]`/... alerts and plain blockquotes in Outpost's native callout style. */
export function GuideBlockquote({
  quotedLines,
  renderNested,
}: {
  quotedLines: string[]
  renderNested: (markdown: string) => ReactNode[]
}) {
  const alertMatch = quotedLines[0]?.trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/)
  if (alertMatch) {
    const kind = alertMatch[1].toLowerCase() as CalloutKind
    const { label, Icon } = CALLOUT_META[kind]
    return (
      <aside className={`guide-callout guide-callout-${kind}`} role="note">
        <div className="guide-callout-title">
          <Icon size={15} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <div className="guide-callout-body">{renderNested(quotedLines.slice(1).join('\n'))}</div>
      </aside>
    )
  }
  return <blockquote>{renderNested(quotedLines.join('\n'))}</blockquote>
}

/** Render a code fence as either a scaled controlled HTML/SVG preview or a syntax-highlighted code block. */
export function GuideCodeFence({ code, language }: { code: string; language: string }) {
  const normalized = language.trim().toLowerCase()
  const htmlMatch = normalized.match(/^html\((\d{2,4})px\)$/)
  if (htmlMatch) {
    const width = Number(htmlMatch[1])
    if (width >= 240 && width <= 1200) {
      return <HtmlPreview content={code} width={width} />
    }
  }
  return <HighlightedCodeBlock code={code} language={normalized} />
}

function highlightCode(code: string, language: string): ReactNode {
  if (language === 'json') return highlightJson(code)
  if (['bash', 'sh', 'shell', 'zsh', 'tmux', 'dotenv'].includes(language)) return highlightShell(code)
  if (['yaml', 'yml'].includes(language)) return highlightYaml(code)
  return code
}

function highlightShell(code: string): ReactNode {
  const lines = code.split('\n')
  return lines.map((line, lineIndex) => {
    const suffix = lineIndex < lines.length - 1 ? '\n' : ''
    if (/^\s*#/.test(line)) {
      return (
        <span key={lineIndex} className="tok-comment">
          {line}
          {suffix}
        </span>
      )
    }
    const tokens: ReactNode[] = []
    // Only match `#` comments after whitespace so URLs like `https://...#anchor` stay intact.
    const re =
      /((?:^|\s)#.*$)|("[^"]*"|'[^']*')|(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(\s--?[A-Za-z0-9-]+)|(\b[A-Z_][A-Z0-9_]{2,}=)/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(line)) !== null) {
      if (match.index > last) tokens.push(line.slice(last, match.index))
      if (match[1])
        tokens.push(
          <span key={tokens.length} className="tok-comment">
            {match[1]}
          </span>,
        )
      else if (match[2])
        tokens.push(
          <span key={tokens.length} className="tok-string">
            {match[2]}
          </span>,
        )
      else if (match[3])
        tokens.push(
          <span key={tokens.length} className="tok-var">
            {match[3]}
          </span>,
        )
      else if (match[4])
        tokens.push(
          <span key={tokens.length} className="tok-flag">
            {match[4]}
          </span>,
        )
      else if (match[5])
        tokens.push(
          <span key={tokens.length} className="tok-key">
            {match[5]}
          </span>,
        )
      last = match.index + match[0].length
    }
    if (last < line.length) tokens.push(line.slice(last))
    return (
      <span key={lineIndex}>
        {tokens}
        {suffix}
      </span>
    )
  })
}

function highlightJson(code: string): ReactNode {
  const tokens: ReactNode[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    if (match.index > last) tokens.push(code.slice(last, match.index))
    if (match[1]) {
      tokens.push(
        <span key={tokens.length} className={match[2] ? 'tok-key' : 'tok-string'}>
          {match[1]}
        </span>,
      )
      if (match[2]) tokens.push(match[2])
    } else if (match[3]) {
      tokens.push(
        <span key={tokens.length} className="tok-keyword">
          {match[3]}
        </span>,
      )
    } else if (match[4]) {
      tokens.push(
        <span key={tokens.length} className="tok-number">
          {match[4]}
        </span>,
      )
    }
    last = match.index + match[0].length
  }
  if (last < code.length) tokens.push(code.slice(last))
  return tokens
}

function highlightYaml(code: string): ReactNode {
  const lines = code.split('\n')
  return lines.map((line, lineIndex) => {
    const suffix = lineIndex < lines.length - 1 ? '\n' : ''
    if (/^\s*#/.test(line)) {
      return (
        <span key={lineIndex} className="tok-comment">
          {line}
          {suffix}
        </span>
      )
    }
    const kv = line.match(/^(\s*[\w.-]+)(:)(.*)$/)
    if (kv) {
      return (
        <span key={lineIndex}>
          <span className="tok-key">{kv[1]}</span>
          {kv[2]}
          {kv[3] && <span className="tok-string">{kv[3]}</span>}
          {suffix}
        </span>
      )
    }
    return (
      <span key={lineIndex}>
        {line}
        {suffix}
      </span>
    )
  })
}

function HighlightedCodeBlock({ code, language }: { code: string; language: string }) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language])
  return (
    <CodeBlock code={code} language={language} defaultLanguage="text">
      {highlighted}
    </CodeBlock>
  )
}

export function ExpandableTable({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const close = useCallback(() => setExpanded(false), [])
  useLightboxBodyLock(expanded, close)

  return (
    <>
      <div className="guide-table-shell">
        <div className="table-scroll">{children}</div>
        <button
          type="button"
          className="guide-table-maximize"
          aria-label="Maximize table"
          title="Maximize table"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>

      {expanded &&
        createPortal(
          <div className="guide-lightbox" role="dialog" aria-modal="true" aria-label="Expanded table" onClick={close}>
            <button type="button" className="guide-lightbox-close" aria-label="Close expanded table" onClick={close}>
              <X size={18} aria-hidden="true" />
            </button>
            <div className="guide-table-lightbox-viewport">
              <div className="guide-table-lightbox-panel" onClick={event => event.stopPropagation()}>
                {children}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function HtmlPreview({ content, width }: { content: string; width: number }) {
  const [expanded, setExpanded] = useState(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState({ height: 0, scale: 1, contentHeight: 0 })
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  const close = useCallback(() => setExpanded(false), [])
  useLightboxBodyLock(expanded, close)

  useEffect(() => {
    const frame = frameRef.current
    const canvas = canvasRef.current
    if (!frame || !canvas) return
    const updateMetrics = () => {
      const availableWidth = frame.clientWidth
      const nextScale = availableWidth > 0 ? availableWidth / width : 1
      const contentHeight = canvas.scrollHeight
      const nextHeight = contentHeight * nextScale
      setMetrics(cur =>
        Math.abs(cur.scale - nextScale) < 0.001 &&
        Math.abs(cur.height - nextHeight) < 1 &&
        Math.abs(cur.contentHeight - contentHeight) < 1
          ? cur
          : { height: nextHeight, scale: nextScale, contentHeight },
      )
    }
    updateMetrics()
    const observer = new ResizeObserver(updateMetrics)
    observer.observe(frame)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [content, width])

  useEffect(() => {
    if (!expanded) return
    const update = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [expanded])

  const expandedScale = useMemo(() => {
    if (!viewportSize.width || !viewportSize.height || !metrics.contentHeight) return 1
    const maxWidth = Math.min(viewportSize.width - 96, 1600)
    const maxHeight = viewportSize.height - 96
    return Math.max(0.25, Math.min(maxWidth / width, maxHeight / metrics.contentHeight))
  }, [metrics.contentHeight, viewportSize.height, viewportSize.width, width])

  return (
    <>
      <div
        className="guide-html-preview"
        role="button"
        tabIndex={0}
        title="Click to expand"
        onClick={() => setExpanded(true)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded(true)
          }
        }}
      >
        <div
          className="guide-html-preview-frame"
          ref={frameRef}
          style={{ height: metrics.height ? `${metrics.height}px` : undefined }}
        >
          <div
            className="guide-html-preview-canvas"
            ref={canvasRef}
            dangerouslySetInnerHTML={{ __html: content }}
            style={
              {
                '--guide-html-width': `${width}px`,
                '--guide-html-scale': metrics.scale,
              } as CSSProperties
            }
          />
        </div>
      </div>

      {expanded &&
        createPortal(
          <div className="guide-lightbox" role="dialog" aria-modal="true" aria-label="Expanded preview" onClick={close}>
            <button type="button" className="guide-lightbox-close" aria-label="Close preview" onClick={close}>
              <X size={18} aria-hidden="true" />
            </button>
            <div className="guide-table-lightbox-viewport">
              <div
                className="guide-html-lightbox-panel"
                onClick={event => event.stopPropagation()}
                style={{
                  width: `${width * expandedScale}px`,
                  height: metrics.contentHeight ? `${metrics.contentHeight * expandedScale}px` : undefined,
                }}
              >
                <div
                  className="guide-html-preview-canvas"
                  dangerouslySetInnerHTML={{ __html: content }}
                  style={
                    {
                      '--guide-html-width': `${width}px`,
                      '--guide-html-scale': expandedScale,
                    } as CSSProperties
                  }
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

export function ImageLightbox({ src, alt }: { src: string; alt: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragSessionRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)
  const suppressNextClickRef = useRef(false)

  const close = useCallback(() => {
    setIsOpen(false)
    setScale(1)
    setOffset({ x: 0, y: 0 })
    dragSessionRef.current = null
    suppressNextClickRef.current = false
  }, [])

  const zoom = useCallback((factor: number) => {
    setScale(current => {
      const next = Math.min(Math.max(current * factor, 1), 4)
      if (next <= 1) setOffset({ x: 0, y: 0 })
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  useLightboxBodyLock(isOpen, close)

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        zoom(1.18)
      } else if ((event.metaKey || event.ctrlKey) && event.key === '-') {
        event.preventDefault()
        zoom(1 / 1.18)
      } else if ((event.metaKey || event.ctrlKey) && event.key === '0') {
        event.preventDefault()
        reset()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, reset, zoom])

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!isOpen) return
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      zoom(Math.exp(-event.deltaY * 0.01))
      return
    }
    if (scale > 1) {
      event.preventDefault()
      setOffset(current => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }))
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (scale <= 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragSessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const didMove = Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 3
    setOffset(current => ({
      x: current.x + event.clientX - session.lastX,
      y: current.y + event.clientY - session.lastY,
    }))
    session.lastX = event.clientX
    session.lastY = event.clientY
    session.moved = session.moved || didMove
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    if (session.moved) suppressNextClickRef.current = true
    dragSessionRef.current = null
  }

  function handleViewportClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (scale === 1 && event.target === event.currentTarget) close()
  }

  function handleImageClick(event: ReactMouseEvent<HTMLImageElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    if (scale === 1) setScale(2)
    else reset()
  }

  return (
    <>
      <figure className="guide-figure">
        <button type="button" className="guide-image-trigger" title="Click to zoom" onClick={() => setIsOpen(true)}>
          <img alt={alt} src={src} loading="lazy" />
        </button>
        {alt && <figcaption>{alt}</figcaption>}
      </figure>

      {isOpen &&
        createPortal(
          <div className="guide-lightbox" role="dialog" aria-modal="true" aria-label={alt || 'Image preview'}>
            <button
              type="button"
              className="guide-lightbox-backdrop"
              aria-label="Close image preview"
              onClick={close}
            />
            <div className="guide-lightbox-toolbar">
              <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.18)}>
                <ZoomOut size={18} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Reset zoom" onClick={reset}>
                <RotateCcw size={18} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Zoom in" onClick={() => zoom(1.18)}>
                <ZoomIn size={18} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Close image preview" onClick={close}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div
              className={`guide-lightbox-viewport${scale > 1 ? ' zoomed' : ''}`}
              onClick={handleViewportClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            >
              <img
                alt={alt}
                className="guide-lightbox-image"
                draggable={false}
                onClick={handleImageClick}
                src={src}
                style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
