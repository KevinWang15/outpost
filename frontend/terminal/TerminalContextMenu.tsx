import type { ImagePasteMode } from '../../shared/terminalFiles'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Check, ClipboardPaste, Copy, Eraser, ImagePlus, Search, TextSelect } from 'lucide-react'
import { isApple, isMac } from '../browser'
import { clearScreenShortcut } from './shortcuts'

interface Props {
  children: ReactElement
  connected: boolean
  actions: {
    canCopy: () => boolean
    copy: () => void
    paste: () => void
    selectAll: () => void
    selectText: () => void
    find: () => void
    clear: () => void
    pasteImage: (mode: ImagePasteMode) => void
    focus: () => void
  }
  controls: { label: string; shown: boolean; onChange: (shown: boolean) => void }[]
}

/** Browser terminal context menu. All commands use the existing terminal
 * controllers; opening it never sends a mouse click or key to the remote app. */
export default function TerminalContextMenu({ children, connected, actions, controls }: Props) {
  const [open, setOpen] = useState(false)
  const [canCopy, setCanCopy] = useState(false)
  const restoreFocus = useRef(true)
  const clearShortcut = clearScreenShortcut(isApple())
  useEffect(() => {
    if (!open) return
    const dismiss = () => {
      restoreFocus.current = false
      setOpen(false)
    }
    const hidden = () => {
      if (document.hidden) dismiss()
    }
    window.addEventListener('blur', dismiss)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [open])
  return (
    <ContextMenu.Root
      open={open}
      modal={false}
      onOpenChange={next => {
        setOpen(next)
        if (!next) return
        restoreFocus.current = true
        actions.focus()
        setCanCopy(actions.canCopy())
      }}
    >
      <ContextMenu.Trigger
        asChild
        onMouseDownCapture={event => {
          const controlClick = event.button === 0 && event.ctrlKey && isMac()
          if (event.button !== 2 && !controlClick) return
          // Preserve the selection and keep xterm's mouse reporting out of this gesture.
          event.stopPropagation()
          event.preventDefault()
          actions.focus()
        }}
        onKeyDownCapture={event => {
          if (
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey))
          )
            return
          event.preventDefault()
          event.stopPropagation()
          const bounds = event.currentTarget.getBoundingClientRect()
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left + 16,
              clientY: bounds.top + 16,
            }),
          )
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="menu terminal-menu"
          aria-label="Terminal actions"
          collisionPadding={8}
          onInteractOutside={() => {
            restoreFocus.current = false
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (restoreFocus.current && document.hasFocus()) actions.focus()
          }}
        >
          <ContextMenu.Item className="menu-item" disabled={!canCopy} onSelect={actions.copy}>
            <Copy size={15} /> Copy
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" disabled={!connected} onSelect={actions.paste}>
            <ClipboardPaste size={15} /> Paste
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={actions.selectAll}>
            <TextSelect size={15} /> Select all
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              restoreFocus.current = false
              actions.selectText()
            }}
          >
            <TextSelect size={15} /> Select text…
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            disabled={!connected}
            onSelect={() => actions.pasteImage('attachment')}
          >
            <ImagePlus size={15} /> Paste an image…
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" disabled={!connected} onSelect={() => actions.pasteImage('path')}>
            <ClipboardPaste size={15} aria-hidden="true" /> Paste image as file path…
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              restoreFocus.current = false
              actions.find()
            }}
          >
            <Search size={15} /> Find in terminal…
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" disabled={!connected} onSelect={actions.clear}>
            <Eraser size={15} /> {clearShortcut.label}
            <span className="terminal-menu-shortcut">{clearShortcut.keys}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          {controls.map(control => (
            <ContextMenu.CheckboxItem
              key={control.label}
              className="menu-item"
              checked={control.shown}
              onCheckedChange={control.onChange}
            >
              <span className="terminal-menu-check">
                <ContextMenu.ItemIndicator>
                  <Check size={15} />
                </ContextMenu.ItemIndicator>
              </span>
              {control.label}
            </ContextMenu.CheckboxItem>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
