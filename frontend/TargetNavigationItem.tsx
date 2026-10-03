import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRight, Ellipsis, Monitor, Server, Trash2 } from 'lucide-react'
import type { Target } from '../shared/session-manager'

function TargetActions({
  menu: { Item, Label, Separator },
  target,
  onOpen,
  onRemove,
}: {
  menu: Pick<typeof DropdownMenu, 'Item' | 'Label' | 'Separator'>
  target: Target
  onOpen: () => void
  onRemove: () => void
}) {
  return (
    <>
      <Label className="target-menu-label">
        {target.name}
        <span>{target.kind === 'ssh' ? 'SSH' : 'Local'} · {target.backends.join(' + ')}</span>
      </Label>
      <Item className="target-menu-item" onSelect={onOpen}>
        <ArrowRight size={16} /> Open target
      </Item>
      <Separator className="target-menu-separator" />
      <Item className="target-menu-item danger" onSelect={onRemove}>
        <Trash2 size={16} /> Remove target…
      </Item>
    </>
  )
}

export default function TargetNavigationItem({
  target,
  selected,
  onSelect,
  onRemove,
}: {
  target: Target
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const actions = { target, onOpen: onSelect, onRemove }
  const TargetIcon = target.kind === 'local' ? Monitor : Server
  return (
    <>
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>
          <div className="target-nav-item">
            <button
              className={`target-nav ${selected ? 'selected' : ''}`}
              aria-label={target.name}
              aria-current={selected ? 'page' : undefined}
              onClick={onSelect}
            >
              <TargetIcon aria-hidden="true" />
              <span>
                <strong className="target-nav-name">{target.name}</strong>
                <small>
                  {target.kind === 'ssh'
                    ? target.host
                    : target.distribution
                      ? `Local · ${target.distribution}`
                      : 'Local'} · {target.backends.join(' + ')}
                </small>
              </span>
            </button>
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <button
                  className="icon-button target-menu-trigger"
                  aria-label={`Target actions for ${target.name}`}
                  title={`Actions for ${target.name}`}
                >
                  <Ellipsis size={16} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="target-menu" align="end" sideOffset={6} collisionPadding={12}>
                  <TargetActions menu={DropdownMenu} {...actions} />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="target-menu" aria-label={`Actions for ${target.name}`} collisionPadding={12}>
            <TargetActions menu={ContextMenu} {...actions} />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  )
}
