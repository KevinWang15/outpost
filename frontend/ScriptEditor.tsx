import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { tags } from '@lezer/highlight'

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operator], color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: 'var(--text)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--teal)' },
  { tag: [tags.string, tags.regexp], color: 'var(--success)' },
  { tag: [tags.number, tags.atom, tags.bool], color: 'var(--warning)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted)' },
  { tag: tags.invalid, color: 'var(--danger)' },
])

export default function ScriptEditor({
  initialValue,
  onChange,
}: {
  initialValue: string
  onChange: (value: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!container.current) return
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          basicSetup,
          StreamLanguage.define(shell),
          syntaxHighlighting(highlighting),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'Installation script',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { fontSize: '13px' },
            '.cm-scroller': {
              fontFamily: 'var(--font-mono)',
              maxHeight: '360px',
              overflow: 'auto',
            },
          }),
        ],
      }),
    })
    return () => view.destroy()
  }, [initialValue, onChange])
  return <div className="script-editor" ref={container} />
}
