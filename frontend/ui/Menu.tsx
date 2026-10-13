import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import type { ReactNode } from 'react'

export interface MenuItem { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }

export function Menu({ label, items, trigger }: { label: string; items: (MenuItem | 'separator')[]; trigger?: ReactNode }) {
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild>
      {trigger ?? <button className="icon-button" aria-label={label} title={label}><Ellipsis size={16} /></button>}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu" align="end" sideOffset={6} collisionPadding={12}>
        {items.map((item, index) => item === 'separator'
          ? <DropdownMenu.Separator key={index} className="menu-separator" />
          : <DropdownMenu.Item key={item.label} className={`menu-item ${item.danger ? 'danger' : ''}`} disabled={item.disabled} onSelect={item.onSelect}>
            {item.icon}{item.label}
          </DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
